'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import { 
  ArrowLeft, 
  Circle, 
  Square, 
  Power, 
  Volume1, 
  Volume2, 
  VolumeX,
  Activity, 
  Maximize2, 
  Minimize2,
  Tv,
  RotateCw,
  Grid,
  Smartphone,
  Moon,
  Gauge,
  SlidersHorizontal,
  Gamepad,
  Speaker,
  X
} from 'lucide-react';
import { AdbScrcpyClient } from '@yume-chan/adb-scrcpy';
import { h264ParseConfiguration, annexBSplitNalu } from '@yume-chan/scrcpy';
import TelemetryHUD from './TelemetryHUD';
import GameMappingOverlay from './GameMappingOverlay';

// Helper to convert H.264 Annex B format (start code separated) to AVCC format (4-byte length separated)
function annexBToAvcc(buffer: Uint8Array): Uint8Array {
  const nalus: Uint8Array[] = [];
  try {
    for (const nalu of annexBSplitNalu(buffer)) {
      nalus.push(nalu);
    }
  } catch (e) {
    // If splitting fails, return raw buffer as fallback
    console.error("Failed to split Annex B NAL units:", e);
    return buffer;
  }

  let totalLength = 0;
  for (const nalu of nalus) {
    totalLength += 4 + nalu.length;
  }

  const avcc = new Uint8Array(totalLength);
  let offset = 0;
  for (const nalu of nalus) {
    const len = nalu.length;
    avcc[offset++] = (len >> 24) & 0xFF;
    avcc[offset++] = (len >> 16) & 0xFF;
    avcc[offset++] = (len >> 8) & 0xFF;
    avcc[offset++] = len & 0xFF;
    avcc.set(nalu, offset);
    offset += len;
  }

  return avcc;
}

// Helper to format SPS & PPS into AVCDecoderConfigurationRecord (avcC) format for WebCodecs
function createAvcCDecoderConfigurationRecord(
  sps: Uint8Array,
  pps: Uint8Array,
  profileIndex: number,
  constraintSet: number,
  levelIndex: number
): Uint8Array {
  const totalLength = 1 + 1 + 1 + 1 + 1 + 1 + 2 + sps.length + 1 + 2 + pps.length;
  const avcC = new Uint8Array(totalLength);
  let offset = 0;

  avcC[offset++] = 1; // configurationVersion
  avcC[offset++] = profileIndex; // AVCProfileIndication
  avcC[offset++] = constraintSet; // profile_compatibility
  avcC[offset++] = levelIndex; // AVCLevelIndication
  avcC[offset++] = 0xFF; // lengthSizeMinusOne (reserved 6 bits + lengthSizeMinusOne 2 bits) -> 0xFF (4 bytes)
  avcC[offset++] = 0xE1; // numOfSequenceParameterSets (reserved 3 bits + numOfSPS 5 bits) -> 0xE1 (1 SPS)

  // SPS length (2 bytes, big endian)
  avcC[offset++] = (sps.length >> 8) & 0xFF;
  avcC[offset++] = sps.length & 0xFF;
  // SPS data
  avcC.set(sps, offset);
  offset += sps.length;

  avcC[offset++] = 1; // numOfPictureParameterSets

  // PPS length (2 bytes, big endian)
  avcC[offset++] = (pps.length >> 8) & 0xFF;
  avcC[offset++] = pps.length & 0xFF;
  // PPS data
  avcC.set(pps, offset);

  return avcC;
}

// Standard Android Motion Event Action Codes
enum AndroidMotionEventAction {
  Down = 0,
  Up = 1,
  Move = 2,
  Cancel = 3
}

interface ScrcpyViewerProps {
  client: AdbScrcpyClient<any>;
  onDisconnect: () => void;
  deviceName?: string;
  onOpenLauncher?: () => void;
  initialTurnScreenOff?: boolean;
  initialAudioEnabled?: boolean;
  initialMuteDeviceSpeaker?: boolean;
  adb?: any;
}

export default function ScrcpyViewer({ client, onDisconnect, deviceName, onOpenLauncher, initialTurnScreenOff, initialAudioEnabled, initialMuteDeviceSpeaker, adb }: ScrcpyViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isMouseDownRef = useRef<boolean>(false);

  const [isTelemetryOpen, setIsTelemetryOpen] = useState<boolean>(false);
  const [isGamepadEnabled, setIsGamepadEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('adb_game_pad_enabled');
      return saved === 'true';
    }
    return false;
  });

  useEffect(() => {
    localStorage.setItem('adb_game_pad_enabled', String(isGamepadEnabled));
  }, [isGamepadEnabled]);
  const [resolution, setResolution] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [fps, setFps] = useState<number>(0);
  const [frameCount, setFrameCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [scaleMode, setScaleMode] = useState<'fit' | 'stretch' | 'center'>('center');
  const [isScreenOff, setIsScreenOff] = useState<boolean>(false);
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(false);
  const [isDeviceSpeakerMuted, setIsDeviceSpeakerMuted] = useState<boolean>(initialMuteDeviceSpeaker ?? false);
  const [sdkVersion, setSdkVersion] = useState<number | null>(null);
  const [ringerMode, setRingerMode] = useState<number | null>(null); // null = Syncing, 0 = Silent, 1 = Vibrate, 2 = Normal
  const [audioStatus, setAudioStatus] = useState<string>('idle');
  const [streamVolumes, setStreamVolumes] = useState<Record<number, number>>({
    3: 10, // Default Media & Music
    2: 10, // Default Ringtone
    5: 10, // Default Notifications
    4: 10, // Default Alarms
    1: 5,  // Default System Sounds
  });
  const [showVolumeMixer, setShowVolumeMixer] = useState<boolean>(false);
  const [volumeIndicator, setVolumeIndicator] = useState<{ visible: boolean; streamId: number; volume: number } | null>(null);
  const volumeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const showVolumeHUD = useCallback((streamId: number, volume: number) => {
    setVolumeIndicator({ visible: true, streamId, volume });
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current);
    }
    volumeTimeoutRef.current = setTimeout(() => {
      setVolumeIndicator(prev => prev ? { ...prev, visible: false } : null);
    }, 2000);
  }, []);

  const fetchRingerMode = useCallback(async () => {
    if (!adb) return;
    try {
      const text = await adb.subprocess.noneProtocol.spawnWaitText('cmd audio get-ringer-mode');
      const match = text.match(/\d+/);
      if (match) {
        setRingerMode(parseInt(match[0], 10));
      }
    } catch (e) {
      console.warn("Failed to fetch ringer mode via ADB:", e);
    }
  }, [adb]);

  const handleSetRingerMode = async (mode: number) => {
    setRingerMode(mode);
    if (!adb) return;
    try {
      await adb.subprocess.noneProtocol.spawnWaitText(`cmd audio set-ringer-mode ${mode}`);
    } catch (e) {
      console.warn(`Failed to set ringer mode to ${mode}:`, e);
    }
  };

  const fetchStreamVolumes = useCallback(async () => {
    if (!adb) return;
    const streams = [
      { id: 3, name: 'Media & Music' },
      { id: 2, name: 'Ringtone' },
      { id: 5, name: 'Notifications' },
      { id: 4, name: 'Alarms' },
      { id: 1, name: 'System Sounds' },
    ];
    const fetched: Record<number, number> = {};
    for (const stream of streams) {
      try {
        const text = await adb.subprocess.noneProtocol.spawnWaitText(`cmd audio get-stream-volume ${stream.id}`);
        const match = text.match(/\d+/);
        if (match) {
          fetched[stream.id] = parseInt(match[0], 10);
        }
      } catch (e) {
        console.warn(`Failed to fetch stream ${stream.id} volume:`, e);
      }
    }
    setStreamVolumes(prev => ({ ...prev, ...fetched }));
  }, [adb]);

  const handleSetStreamVolume = async (streamId: number, value: number) => {
    setStreamVolumes(prev => ({ ...prev, [streamId]: value }));
    showVolumeHUD(streamId, value);
    if (!adb) return;
    try {
      await adb.subprocess.noneProtocol.spawnWaitText(`cmd audio set-stream-volume ${streamId} ${value}`);
    } catch (e) {
      console.warn(`Failed to set stream ${streamId} volume to ${value}:`, e);
    }
  };

  // Fetch stream volumes and ringer mode on mount or connection asynchronously to avoid cascading renders
  useEffect(() => {
    if (adb) {
      const timeoutId = setTimeout(() => {
        fetchStreamVolumes().catch(err => console.warn("Failed to fetch stream volumes on mount:", err));
        fetchRingerMode().catch(err => console.warn("Failed to fetch ringer mode on mount:", err));
      }, 150);
      return () => clearTimeout(timeoutId);
    }
  }, [adb, fetchStreamVolumes, fetchRingerMode]);

  // Keep refs of latest values for cleanup without triggering effect re-runs
  const latestMuteRef = useRef(isDeviceSpeakerMuted);
  const latestMediaVolRef = useRef(streamVolumes[3] ?? 10);
  useEffect(() => {
    latestMuteRef.current = isDeviceSpeakerMuted;
  }, [isDeviceSpeakerMuted]);
  useEffect(() => {
    latestMediaVolRef.current = streamVolumes[3] ?? 10;
  }, [streamVolumes]);

  // Fetch the device's SDK version on mount/connection
  useEffect(() => {
    if (!adb) return;
    const fetchDeviceSdkVersion = async () => {
      try {
        const versionStr = await adb.subprocess.noneProtocol.spawnWaitText("getprop ro.build.version.sdk");
        const parsedVersion = parseInt(versionStr.trim(), 10);
        if (!isNaN(parsedVersion)) {
          setSdkVersion(parsedVersion);
          console.log(`[WebADB] Connected to Android SDK level: ${parsedVersion}`);
        }
      } catch (e) {
        console.warn("Failed to identify Android SDK version via getprop:", e);
      }
    };
    fetchDeviceSdkVersion();
  }, [adb]);

  // Adaptive responsive audio controller for old vs new Android versions
  useEffect(() => {
    if (!adb) return;
    const updateDeviceSpeakerMute = async () => {
      try {
        // Android 13 is SDK 33 or higher
        if (sdkVersion && sdkVersion >= 33) {
          // Modern Android: Safe to use native stream muting configurations
          await adb.subprocess.noneProtocol.spawnWaitText(`cmd audio set-stream-mute 3 ${isDeviceSpeakerMuted ? 'true' : 'false'}`);
        } else {
          // Older Android (11/12): Muting kills the virtual mixer thread. 
          // We drop volume amplitude to 0 instead to keep capture streams alive.
          if (isDeviceSpeakerMuted) {
            await adb.subprocess.noneProtocol.spawnWaitText(`cmd audio set-stream-volume 3 0`);
          } else {
            const activeMediaVol = streamVolumes[3] ?? 10;
            await adb.subprocess.noneProtocol.spawnWaitText(`cmd audio set-stream-volume 3 ${activeMediaVol}`);
          }
        }
      } catch (e) {
        console.warn("Failed to apply version-responsive speaker adjustments via ADB:", e);
      }
    };
    updateDeviceSpeakerMute();
  }, [isDeviceSpeakerMuted, adb, sdkVersion, streamVolumes]);

  // Safe recovery on unmount/disconnect to restore physical phone states cleanly
  useEffect(() => {
    return () => {
      if (adb) {
        const savedVol = latestMediaVolRef.current;
        const restoreDeviceState = async () => {
          try {
            await adb.subprocess.noneProtocol.spawnWaitText("cmd audio set-stream-mute 3 false");
            await adb.subprocess.noneProtocol.spawnWaitText(`cmd audio set-stream-volume 3 ${savedVol}`);
          } catch (e) {
            console.warn("Failed to restore phone physical speaker state on unmount:", e);
          }
        };
        restoreDeviceState();
      }
    };
  }, [adb]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const nextPlaybackTimeRef = useRef<number>(0);

  // Close AudioContext on unmount
  useEffect(() => {
    return () => {
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch((e) => console.error("Failed to close AudioContext on unmount", e));
        audioCtxRef.current = null;
      }
    };
  }, []);



  const initAudio = useCallback(() => {
    if (audioCtxRef.current) return { ctx: audioCtxRef.current, gain: gainNodeRef.current! };

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) {
      console.warn("AudioContext is not supported in this browser");
      setAudioStatus('unsupported');
      return null;
    }

    const ctx = new AudioContextClass();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    
    gain.gain.value = 1;

    audioCtxRef.current = ctx;
    gainNodeRef.current = gain;

    return { ctx, gain };
  }, []);

  // Synchronize mute state with GainNode
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = isAudioMuted ? 0 : 1;
    }
  }, [isAudioMuted]);

  const toggleMute = async () => {
    const audioObj = initAudio();
    if (!audioObj) return;

    const { ctx } = audioObj;

    if (isAudioMuted) {
      try {
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        setIsAudioMuted(false);
      } catch (err) {
        console.error("Failed to resume AudioContext:", err);
      }
    } else {
      setIsAudioMuted(true);
    }
  };

  const handleStartAudioContext = useCallback(() => {
    const audioObj = initAudio();
    if (audioObj && audioObj.ctx.state === 'suspended') {
      audioObj.ctx.resume().then(() => {
        console.log("[WebADB] Audio Context successfully activated via explicit user action.");
      }).catch(err => console.error("Failed to wake audio context:", err));
    }
  }, [initAudio]);
  const [viewRotation, setViewRotationState] = useState<0 | 90 | 180 | 270>(0);
  const viewRotationRef = useRef<0 | 90 | 180 | 270>(0);

  const [deviceRotation, setDeviceRotationState] = useState<0 | 1 | 2 | 3>(0);

  const setViewRotation = (rot: 0 | 90 | 180 | 270) => {
    viewRotationRef.current = rot;
    setViewRotationState(rot);
  };

  const handleDeviceRotate = () => {
    const next = ((deviceRotation + 1) % 4) as 0 | 1 | 2 | 3;
    setDeviceRotationState(next);
    if (client.controller?.rotateDevice) {
      client.controller.rotateDevice().catch(err => {
        console.error("Failed to rotate device:", err);
      });
    }
  };

  // Sync fullscreen state with document state
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isRealFs = !!document.fullscreenElement;
      if (!isRealFs && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [isFullscreen]);

  // Calculate FPS every second
  useEffect(() => {
    const interval = setInterval(() => {
      setFps(frameCount);
      setFrameCount(0);
    }, 1000);
    return () => clearInterval(interval);
  }, [frameCount]);

  // Apply initial screen power state from settings
  useEffect(() => {
    if (client && client.controller) {
      if (initialTurnScreenOff) {
        // Add a slight delay to ensure controller is fully ready to process messages
        setTimeout(() => {
          setIsScreenOff(true);
          client.controller?.setScreenPowerMode?.(0).catch((e) => {
             console.error("Failed to set initial screen power mode", e);
          });
        }, 500);
      }
    }
  }, [client, initialTurnScreenOff]);

  // Video stream consumer and decoder loop
  useEffect(() => {
    if (!client) return;
    let active = true;
    let decoder: VideoDecoder | null = null;
    let reader: any = null;

    async function startDecoding() {
      try {
        // Initialize WebCodecs VideoDecoder
        decoder = new VideoDecoder({
          output: (frame) => {
            if (!active) {
              frame.close();
              return;
            }
            const canvas = canvasRef.current;
            if (canvas) {
              const ctx = canvas.getContext('2d');
              if (ctx) {
                const rot = viewRotationRef.current;
                const isRotated = rot === 90 || rot === 270;
                const targetWidth = isRotated ? frame.displayHeight : frame.displayWidth;
                const targetHeight = isRotated ? frame.displayWidth : frame.displayHeight;

                // Resize canvas buffer when device orientation/resolution/rotation changes
                if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                  canvas.width = targetWidth;
                  canvas.height = targetHeight;
                  setResolution({ width: targetWidth, height: targetHeight });
                }

                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.save();
                if (rot === 90) {
                  ctx.translate(canvas.width, 0);
                  ctx.rotate(Math.PI / 2);
                } else if (rot === 180) {
                  ctx.translate(canvas.width, canvas.height);
                  ctx.rotate(Math.PI);
                } else if (rot === 270) {
                  ctx.translate(0, canvas.height);
                  ctx.rotate(-Math.PI / 2);
                }
                ctx.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
                ctx.restore();

                setFrameCount((prev) => prev + 1);
              }
            }
            frame.close();
          },
          error: (err) => {
            console.error("WebCodecs VideoDecoder internal error:", err);
            setError("Decoder error: " + err.message);
          }
        });

        // Get the Scrcpy video stream object
        const videoStream = await client.videoStream;
        if (!active) return;

        if (!videoStream || !videoStream.stream) {
          throw new Error("Scrcpy client returned an invalid video stream.");
        }

        reader = videoStream.stream.getReader();

        while (active) {
          const { value, done } = await reader.read();
          if (done || !active) break;

          // Handle incoming scrcpy packets
          if (value.type === 'configuration') {
            try {
              // Parse the Sequence Parameter Set (SPS) and Picture Parameter Set (PPS)
              const config = h264ParseConfiguration(value.data);
              
              // Generate standard AVCDecoderConfigurationRecord (avcC) bytes for WebCodecs
              const avcC = createAvcCDecoderConfigurationRecord(
                config.sequenceParameterSet,
                config.pictureParameterSet,
                config.profileIndex,
                config.constraintSet,
                config.levelIndex
              );

              // Dynamically build the H.264 codec string using profile and level indicators
              const profileHex = config.profileIndex.toString(16).padStart(2, '0');
              const constraintHex = config.constraintSet.toString(16).padStart(2, '0');
              const levelHex = config.levelIndex.toString(16).padStart(2, '0');
              const codecStr = `avc1.${profileHex}${constraintHex}${levelHex}`;

              console.log(`Configuring VideoDecoder with codec: ${codecStr}, size: ${config.croppedWidth}x${config.croppedHeight}`);
              
              setResolution({ width: config.croppedWidth, height: config.croppedHeight });

              decoder.configure({
                codec: codecStr,
                description: avcC,
                optimizeForLatency: true,
              });
            } catch (err: any) {
              console.error("Failed to parse/construct H264 avcC configuration, attempting raw fallback:", err);
              decoder.configure({
                codec: 'avc1.64002a', // standard compatible H.264 profile fallback
                description: value.data,
                optimizeForLatency: true,
              });
            }
          } else if (value.type === 'data') {
            if (decoder.state === 'configured') {
              try {
                const avccData = annexBToAvcc(value.data);
                const chunk = new EncodedVideoChunk({
                  type: value.keyframe ? 'key' : 'delta',
                  timestamp: value.pts !== undefined ? Number(value.pts) : 0,
                  data: avccData,
                });
                decoder.decode(chunk);
              } catch (decodeErr: any) {
                console.error("Failed to construct EncodedVideoChunk or decode:", decodeErr);
              }
            }
          }
        }
      } catch (err: any) {
        console.error("WebCodecs decoding loop error:", err);
        if (active) {
          setError("Stream closed: " + (err?.message || String(err)));
        }
      }
    }

    startDecoding();

    return () => {
      active = false;
      if (reader) {
        reader.cancel().catch(() => {});
      }
      if (decoder) {
        try {
          if (decoder.state !== 'closed') {
            decoder.close();
          }
        } catch (e) {
          console.error("Error cleaning up VideoDecoder:", e);
        }
      }
    };
  }, [client]);

  // Audio stream consumer and decoder loop
  useEffect(() => {
    if (!client || !initialAudioEnabled) return;
    let active = true;
    let decoder: AudioDecoder | null = null;
    let reader: any = null;

    async function startAudioDecoding() {
      try {
        if (typeof AudioDecoder === 'undefined') {
          console.warn("WebCodecs AudioDecoder is not supported in this browser.");
          setAudioStatus('unsupported');
          return;
        }

        const audioStreamMetadata = await client.audioStream;
        if (!active) return;

        if (!audioStreamMetadata) {
          console.log("No audio stream returned by the client.");
          setAudioStatus('idle');
          return;
        }

        if (audioStreamMetadata.type === 'disabled') {
          console.log("Audio streaming is disabled.");
          setAudioStatus('idle');
          return;
        }

        if (audioStreamMetadata.type === 'errored') {
          console.error("Audio stream errored on start.");
          setAudioStatus('error');
          return;
        }

        const audioStream = audioStreamMetadata.stream;
        if (!audioStream) {
          console.warn("Audio stream is empty.");
          return;
        }

        setAudioStatus('playing');
        reader = audioStream.getReader();

        decoder = new AudioDecoder({
          output: (audioData) => {
            if (!active) {
              audioData.close();
              return;
            }

            const audioObj = initAudio();
            if (!audioObj) {
              audioData.close();
              return;
            }

            const { ctx, gain } = audioObj;

            try {
              const sampleRate = audioData.sampleRate;
              const numberOfChannels = audioData.numberOfChannels;
              const numberOfFrames = audioData.numberOfFrames;
              const format = audioData.format;

              const audioBuffer = ctx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);

              for (let channel = 0; channel < numberOfChannels; channel++) {
                const channelData = audioBuffer.getChannelData(channel);
                if (format === 'f32-planar') {
                  audioData.copyTo(channelData, { planeIndex: channel });
                } else if (format === 'f32') {
                  const interleaved = new Float32Array(numberOfFrames * numberOfChannels);
                  audioData.copyTo(interleaved, { planeIndex: 0 });
                  for (let i = 0; i < numberOfFrames; i++) {
                    channelData[i] = interleaved[i * numberOfChannels + channel];
                  }
                } else if (format === 's16-planar') {
                  const intBuffer = new Int16Array(numberOfFrames);
                  audioData.copyTo(intBuffer, { planeIndex: channel });
                  for (let i = 0; i < numberOfFrames; i++) {
                    channelData[i] = intBuffer[i] / 32768;
                  }
                } else if (format === 's16') {
                  const interleaved = new Int16Array(numberOfFrames * numberOfChannels);
                  audioData.copyTo(interleaved, { planeIndex: 0 });
                  for (let i = 0; i < numberOfFrames; i++) {
                    channelData[i] = interleaved[i * numberOfChannels + channel] / 32768;
                  }
                } else if (format === 's32-planar') {
                  const intBuffer = new Int32Array(numberOfFrames);
                  audioData.copyTo(intBuffer, { planeIndex: channel });
                  for (let i = 0; i < numberOfFrames; i++) {
                    channelData[i] = intBuffer[i] / 2147483648;
                  }
                } else if (format === 's32') {
                  const interleaved = new Int32Array(numberOfFrames * numberOfChannels);
                  audioData.copyTo(interleaved, { planeIndex: 0 });
                  for (let i = 0; i < numberOfFrames; i++) {
                    channelData[i] = interleaved[i * numberOfChannels + channel] / 2147483648;
                  }
                } else {
                  audioData.copyTo(channelData, { planeIndex: channel });
                }
              }

              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(gain);

              const now = ctx.currentTime;
              if (ctx.state === 'suspended' || nextPlaybackTimeRef.current < now) {
                nextPlaybackTimeRef.current = now + 0.05;
              }
              source.start(nextPlaybackTimeRef.current);
              nextPlaybackTimeRef.current += audioBuffer.duration;
            } catch (err) {
              console.error("[AudioDecoder] Error parsing/playing audio frame:", err);
            } finally {
              audioData.close();
            }
          },
          error: (err) => {
            console.error("[AudioDecoder] Internal decoder error:", err);
            setAudioStatus('error');
          }
        });

        while (active) {
          const { value, done } = await reader.read();
          if (done || !active) break;

          if (value.type === 'configuration') {
            const codec = audioStreamMetadata.codec;
            const webCodecId = codec.webCodecId || 'opus';
            console.log(`[AudioDecoder] Configuring with codec: ${webCodecId}`);
            decoder.configure({
              codec: webCodecId,
              sampleRate: 48000,
              numberOfChannels: 2,
              description: value.data,
            });
          } else if (value.type === 'data') {
            if (decoder.state === 'configured') {
              try {
                const chunk = new EncodedAudioChunk({
                  type: 'key',
                  timestamp: value.pts !== undefined ? Number(value.pts) : 0,
                  data: value.data,
                });
                decoder.decode(chunk);
              } catch (decodeErr) {
                console.error("[AudioDecoder] DecodedAudioChunk decode failed:", decodeErr);
              }
            }
          }
        }
      } catch (err: any) {
        console.error("Audio streaming/decoding loop error:", err);
        if (active) {
          setAudioStatus('error');
        }
      }
    }

    startAudioDecoding();

    return () => {
      active = false;
      if (reader) {
        reader.cancel().catch(() => {});
      }
      if (decoder) {
        try {
          if (decoder.state !== 'closed') {
            decoder.close();
          }
        } catch (e) {}
      }
    };
  }, [client, initialAudioEnabled, initAudio]);

  // Map pointer event coordinates and send to ADB control stream
  const sendTouchEvent = async (
    action: AndroidMotionEventAction,
    e: React.MouseEvent<HTMLCanvasElement>
  ) => {
    if (!client || !canvasRef.current) return;

    // Auto-resume AudioContext on user touch/click interaction on the canvas
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended' && !isAudioMuted) {
      audioCtxRef.current.resume().catch((err) => console.error("Failed to auto-resume AudioContext:", err));
    }

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();

    // Layout relative coordinates
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    let scaleX = rect.width / canvas.width;
    let scaleY = rect.height / canvas.height;
    
    let offsetX = 0;
    let offsetY = 0;
    let drawWidth = rect.width;
    let drawHeight = rect.height;

    // Adjust for object-contain letterboxing
    if (scaleMode !== 'stretch') {
      const scale = Math.min(scaleX, scaleY);
      drawWidth = canvas.width * scale;
      drawHeight = canvas.height * scale;
      offsetX = (rect.width - drawWidth) / 2;
      offsetY = (rect.height - drawHeight) / 2;
      scaleX = scale;
      scaleY = scale;
    }

    const imageClientX = clientX - offsetX;
    const imageClientY = clientY - offsetY;

    // Ignore events that happen in the black letterbox borders
    if (
      imageClientX < 0 || 
      imageClientX > drawWidth || 
      imageClientY < 0 || 
      imageClientY > drawHeight
    ) {
      return;
    }

    // Map relative layout coords to intrinsic canvas coords
    const x = imageClientX / scaleX;
    const y = imageClientY / scaleY;

    // Calculate unrotated dimensions for original scrcpy coordinates
    const rot = viewRotationRef.current;
    const isRotated = rot === 90 || rot === 270;
    const origWidth = isRotated ? canvas.height : canvas.width;
    const origHeight = isRotated ? canvas.width : canvas.height;

    // Translate coordinates back to unrotated space
    let pointerX = x;
    let pointerY = y;

    if (rot === 90) {
      pointerX = y;
      pointerY = origHeight - x;
    } else if (rot === 180) {
      pointerX = origWidth - x;
      pointerY = origHeight - y;
    } else if (rot === 270) {
      pointerX = origWidth - y;
      pointerY = x;
    }

    try {
      if (client.controller?.injectTouch) {
        await client.controller.injectTouch({
          action,
          pointerId: BigInt(0),
          pointerX,
          pointerY,
          videoWidth: origWidth,
          videoHeight: origHeight,
          pressure: action === AndroidMotionEventAction.Up ? 0 : 1,
          actionButton: 0,
          buttons: action === AndroidMotionEventAction.Up ? 0 : 1,
        });
      }
    } catch (err) {
      console.error("Failed to inject pointer event:", err);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    handleStartAudioContext();
    isMouseDownRef.current = true;
    sendTouchEvent(AndroidMotionEventAction.Down, e);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!isMouseDownRef.current) return;
    sendTouchEvent(AndroidMotionEventAction.Move, e);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!isMouseDownRef.current) return;
    isMouseDownRef.current = false;
    sendTouchEvent(AndroidMotionEventAction.Up, e);
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!isMouseDownRef.current) return;
    isMouseDownRef.current = false;
    sendTouchEvent(AndroidMotionEventAction.Cancel, e);
  };

  // Safe Android control injection wrappers
  const handleNavAction = async (actionType: 'back' | 'home' | 'appSwitch' | 'power' | 'volumeUp' | 'volumeDown') => {
    if (!client || !client.controller) return;
    try {
      const ctrl = client.controller as any;
      if (actionType === 'home') {
        if (typeof ctrl.home === 'function') await ctrl.home();
        else await injectKeyCodePair(3); // HOME keycode
      } else if (actionType === 'back') {
        if (typeof ctrl.back === 'function') await ctrl.back();
        else await injectKeyCodePair(4); // BACK keycode
      } else if (actionType === 'appSwitch') {
        if (typeof ctrl.appSwitch === 'function') await ctrl.appSwitch();
        else await injectKeyCodePair(187); // APP_SWITCH keycode
      } else if (actionType === 'power') {
        if (typeof ctrl.power === 'function') await ctrl.power();
        else await injectKeyCodePair(26); // POWER keycode
      } else if (actionType === 'volumeUp') {
        const currentMediaVol = streamVolumes[3] ?? 10;
        const newMediaVol = Math.min(15, currentMediaVol + 1);
        await handleSetStreamVolume(3, newMediaVol);
      } else if (actionType === 'volumeDown') {
        const currentMediaVol = streamVolumes[3] ?? 10;
        const newMediaVol = Math.max(0, currentMediaVol - 1);
        await handleSetStreamVolume(3, newMediaVol);
      }
    } catch (err) {
      console.error(`Failed navigation action ${actionType}:`, err);
    }
  };

  const injectKeyCodePair = async (keyCode: number) => {
    if (!client || !client.controller || !client.controller.injectKeyCode) return;
    try {
      await client.controller.injectKeyCode({
        action: 0, // Down
        keyCode: keyCode as any,
        repeat: 0,
        metaState: 0,
      });
      await client.controller.injectKeyCode({
        action: 1, // Up
        keyCode: keyCode as any,
        repeat: 0,
        metaState: 0,
      });
    } catch (e) {
      console.error("Failed to inject keycode pair:", e);
    }
  };

  // Fullscreen helper
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!isFullscreen) {
      setIsFullscreen(true);
      containerRef.current.requestFullscreen().catch(err => {
        console.warn("Natively entering fullscreen failed, falling back to simulated inline fullscreen:", err);
      });
    } else {
      setIsFullscreen(false);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => {
          console.warn("Failed to exit native fullscreen:", err);
        });
      }
    }
  };

  // Reusable Action Buttons to prevent code duplication
  const getButtonClass = (isActive: boolean, type: 'emerald' | 'amber' | 'neutral' | 'red' | 'blue', isFloating: boolean) => {
    if (isFloating) {
      const base = "p-1.5 rounded-lg transition-colors border flex items-center justify-center ";
      if (type === 'emerald') {
        return base + (isActive ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/30 hover:bg-emerald-900' : 'bg-gray-900/80 text-gray-400 border-gray-700/50 hover:bg-gray-800');
      } else if (type === 'amber') {
        return base + (isActive ? 'bg-amber-950/80 text-amber-400 border-amber-900/50 hover:bg-amber-900' : 'bg-emerald-950/80 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900');
      } else if (type === 'red') {
        return "p-1.5 bg-gray-900/80 hover:bg-red-950/80 border border-gray-700/50 text-red-400 rounded-lg transition-colors flex items-center justify-center";
      } else if (type === 'blue') {
        return "p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-blue-400 rounded-lg transition-colors flex items-center justify-center";
      } else {
        return "p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-gray-300 rounded-lg transition-colors flex items-center justify-center";
      }
    } else {
      const base = "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border flex items-center space-x-1.5 ";
      if (type === 'emerald') {
        return base + (isActive ? 'bg-emerald-950/40 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900/60' : 'bg-gray-800/50 text-gray-400 border-transparent hover:bg-gray-800 hover:text-gray-200');
      } else if (type === 'amber') {
        return base + (isActive ? 'bg-amber-950/40 text-amber-500 border-amber-900/50 hover:bg-amber-900/60' : 'bg-emerald-950/40 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900/60');
      } else if (type === 'red') {
        return "p-2 text-gray-400 hover:text-red-400 hover:bg-red-950/20 rounded-lg transition-colors border border-transparent hover:border-red-900/30 flex items-center justify-center";
      } else if (type === 'blue') {
        return "p-2 text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/20 rounded-lg transition-colors flex items-center space-x-1 border border-transparent hover:border-emerald-900/30";
      } else {
        return "p-2 text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors flex items-center justify-center";
      }
    }
  };

  const getRingerButtonClass = (isFloating: boolean) => {
    if (isFloating) {
      const base = "p-1.5 rounded-lg transition-colors border flex items-center justify-center ";
      return base + (
        ringerMode === 2 ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/30 hover:bg-emerald-900' :
        ringerMode === 1 ? 'bg-amber-950/80 text-amber-400 border-amber-500/30 hover:bg-amber-900' :
        ringerMode === 0 ? 'bg-slate-950/80 text-slate-400 border-slate-700/50 hover:bg-slate-800' :
        'bg-gray-900/80 text-gray-300 border-gray-700/50 hover:bg-gray-800'
      );
    } else {
      const base = "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border flex items-center space-x-1.5 ";
      return base + (
        ringerMode === 2 ? 'bg-emerald-950/40 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900/60' :
        ringerMode === 1 ? 'bg-amber-950/40 text-amber-500 border-amber-900/50 hover:bg-amber-900/60' :
        ringerMode === 0 ? 'bg-slate-950/40 text-slate-400 border-slate-900/50 hover:bg-slate-800/60' :
        'bg-gray-800/50 text-gray-400 border-transparent hover:bg-gray-800'
      );
    }
  };

  const renderScreenPowerBtn = (isFloating: boolean) => {
    const isActive = !isScreenOff;
    return (
      <button
        onClick={async () => {
          if (client.controller?.setScreenPowerMode) {
            try {
              const newMode = isScreenOff ? 2 : 0;
              await client.controller.setScreenPowerMode(newMode);
              setIsScreenOff(!isScreenOff);
            } catch (e) {
              console.error('Failed to toggle screen power mode', e);
            }
          }
        }}
        className={
          isFloating
            ? isActive 
              ? 'p-1.5 rounded-lg transition-colors bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-900 flex items-center justify-center'
              : 'p-1.5 rounded-lg transition-colors bg-red-950/20 text-red-400 border border-red-900/30 hover:bg-red-950/40 flex items-center justify-center'
            : isActive
              ? 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border bg-emerald-950/40 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900/60 flex items-center space-x-1.5'
              : 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border bg-gray-800/50 text-red-400 border-transparent hover:bg-gray-800 flex items-center space-x-1.5'
        }
        title="Toggle Physical Device Screen (Keep Mirroring Alive)"
      >
        {isActive ? <Smartphone className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        {!isFloating && <span className="hidden sm:inline">{isScreenOff ? "Screen Off" : "Screen On"}</span>}
      </button>
    );
  };

  const renderTelemetryBtn = (isFloating: boolean) => (
    <button
      onClick={() => setIsTelemetryOpen(!isTelemetryOpen)}
      className={
        isFloating
          ? isTelemetryOpen
            ? 'p-1.5 rounded-lg transition-colors bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-900 flex items-center justify-center'
            : 'p-1.5 rounded-lg transition-colors bg-gray-900/80 text-gray-400 border border-gray-700/50 hover:bg-gray-800 flex items-center justify-center'
          : isTelemetryOpen
            ? 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border bg-emerald-950/40 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900/60 flex items-center space-x-1.5'
            : 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border bg-gray-800/50 text-gray-400 border-transparent hover:bg-gray-800 flex items-center space-x-1.5'
      }
      title="Toggle Hardware Telemetry HUD"
    >
      <Gauge className="w-4 h-4" />
      {!isFloating && <span className="hidden sm:inline">Telemetry HUD</span>}
    </button>
  );

  const renderGamepadBtn = (isFloating: boolean) => (
    <button
      onClick={() => setIsGamepadEnabled(!isGamepadEnabled)}
      className={
        isFloating
          ? isGamepadEnabled
            ? 'p-1.5 rounded-lg transition-colors bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-900 flex items-center justify-center'
            : 'p-1.5 rounded-lg transition-colors bg-gray-900/80 text-gray-400 border border-gray-700/50 hover:bg-gray-800 flex items-center justify-center'
          : isGamepadEnabled
            ? 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border bg-emerald-950/40 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900/60 flex items-center space-x-1.5'
            : 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border bg-gray-800/50 text-gray-400 border-transparent hover:bg-gray-800 flex items-center space-x-1.5'
      }
      title="Toggle Gaming Control Mapping Overlay Engine"
    >
      <Gamepad className="w-4 h-4" />
      {!isFloating && <span className="hidden sm:inline">{isGamepadEnabled ? "Game Controls: ON" : "Game Controls: OFF"}</span>}
    </button>
  );

  const renderAudioBtn = (isFloating: boolean) => {
    if (!initialAudioEnabled) return null;
    const isActive = !isAudioMuted;
    return (
      <button
        onClick={toggleMute}
        className={
          isFloating
            ? isActive
              ? 'p-1.5 rounded-lg transition-colors bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-900 flex items-center justify-center'
              : 'p-1.5 rounded-lg transition-colors bg-red-950/20 text-red-400 border border-red-900/30 hover:bg-red-950/40 flex items-center justify-center'
            : isActive
              ? 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border bg-emerald-950/40 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900/60 flex items-center space-x-1.5'
              : 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border bg-gray-800/50 text-red-400 border-transparent hover:bg-gray-800 flex items-center space-x-1.5'
        }
        title={isAudioMuted ? `Unmute PC Audio (Status: ${audioStatus})` : `Mute PC Audio (Status: ${audioStatus})`}
      >
        {isActive ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
        {!isFloating && <span className="hidden sm:inline">{isAudioMuted ? "PC Muted" : "PC Audio Live"}</span>}
      </button>
    );
  };

  const renderRingerBtn = (isFloating: boolean) => !initialAudioEnabled ? null : (
    <button
      onClick={() => {
        const nextMode = ringerMode === 2 ? 1 : ringerMode === 1 ? 0 : 2;
        handleSetRingerMode(nextMode);
      }}
      className={getRingerButtonClass(isFloating)}
      title={
        ringerMode === 2 ? "Phone Sound is Normal. Click to set Vibrate." :
        ringerMode === 1 ? "Phone Sound is Vibrate. Click to set Silent." :
        ringerMode === 0 ? "Phone Sound is Silent. Click to set Normal." :
        "Syncing Phone Sound Mode..."
      }
    >
      {ringerMode === 2 ? <Volume2 className="w-4 h-4" /> :
       ringerMode === 1 ? <Activity className="w-4 h-4" /> :
       ringerMode === 0 ? <VolumeX className="w-4 h-4" /> :
       <Smartphone className="w-4 h-4" />}
      {!isFloating && (
        <span className="hidden sm:inline">
          {ringerMode === 2 ? "Phone: Sound" :
           ringerMode === 1 ? "Phone: Vibrate" :
           ringerMode === 0 ? "Phone: Silent" :
           "Phone: Syncing..."}
        </span>
      )}
    </button>
  );

  const renderSpeakerBtn = (isFloating: boolean) => {
    if (!initialAudioEnabled) return null;
    const isUnsupported = !!(sdkVersion && sdkVersion < 30);
    const isActive = !isDeviceSpeakerMuted && !isUnsupported;
    return (
      <button
        onClick={() => setIsDeviceSpeakerMuted(!isDeviceSpeakerMuted)}
        className={
          isFloating
            ? isUnsupported
              ? 'p-1.5 rounded-lg bg-gray-900/30 text-gray-600 border border-gray-800/50 cursor-not-allowed flex items-center justify-center'
              : isActive
                ? 'p-1.5 rounded-lg transition-colors bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-900 flex items-center justify-center'
                : 'p-1.5 rounded-lg transition-colors bg-red-950/20 text-red-400 border border-red-900/30 hover:bg-red-950/40 flex items-center justify-center'
            : isUnsupported
              ? 'px-3 py-1.5 text-xs font-medium rounded-lg border bg-gray-800/10 text-gray-500 border-transparent cursor-not-allowed flex items-center space-x-1.5'
              : isActive
                ? 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border bg-emerald-950/40 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900/60 flex items-center space-x-1.5'
                : 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border bg-gray-800/50 text-red-400 border-transparent hover:bg-gray-800 flex items-center space-x-1.5'
        }
        title={
          isUnsupported 
            ? "Audio streaming and hardware speaker control is unsupported below Android 11" 
            : isDeviceSpeakerMuted 
              ? "Unmute Physical Phone Speaker (Currently Silent on Phone, Playing on PC)" 
              : "Mute Physical Phone Speaker (Keep Audio Playing on PC)"
        }
        disabled={isUnsupported}
      >
        <Speaker className="w-4 h-4" />
        {!isFloating && (
          <span className="hidden sm:inline">
            {isUnsupported 
              ? "Phone Spk: Unsupported" 
              : isDeviceSpeakerMuted 
                ? "Phone Spk: Muted" 
                : "Phone Spk: Live"}
          </span>
        )}
      </button>
    );
  };

  const renderPowerBtn = (isFloating: boolean) => (
    <button
      onClick={() => handleNavAction('power')}
      className={getButtonClass(false, 'red', isFloating)}
      title="Power Button"
    >
      <Power className="w-4 h-4" />
    </button>
  );

  const renderVolDownBtn = (isFloating: boolean) => (
    <button
      onClick={() => handleNavAction('volumeDown')}
      className={getButtonClass(false, 'neutral', isFloating)}
      title="Volume Down"
    >
      <Volume1 className="w-4 h-4" />
    </button>
  );

  const renderVolUpBtn = (isFloating: boolean) => (
    <button
      onClick={() => handleNavAction('volumeUp')}
      className={getButtonClass(false, 'neutral', isFloating)}
      title="Volume Up"
    >
      <Volume2 className="w-4 h-4" />
    </button>
  );

  const renderRotateBtn = (isFloating: boolean) => (
    <button
      onClick={handleDeviceRotate}
      className={getButtonClass(false, 'blue', isFloating)}
      title="Rotate Device OS"
    >
      <RotateCw className="w-4 h-4" />
      {!isFloating && <span className="hidden sm:inline text-xs text-emerald-400 font-medium ml-1">Rotate OS</span>}
    </button>
  );

  const renderLauncherBtn = (isFloating: boolean) => (
    <button
      onClick={onOpenLauncher}
      className={isFloating 
        ? "p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-emerald-400 rounded-lg transition-colors flex items-center justify-center"
        : "p-2 text-emerald-400 bg-emerald-950/20 hover:bg-emerald-900/40 rounded-lg transition-colors flex items-center space-x-1 border border-emerald-900/30"
      }
      title="App Launcher"
    >
      <Grid className="w-4 h-4" />
      {!isFloating && <span className="hidden sm:inline text-xs font-semibold">Launcher</span>}
    </button>
  );

  const renderMixerBtn = (isFloating: boolean) => (
    <div className="relative inline-block self-center">
      <button
        onClick={() => {
          setShowVolumeMixer(!showVolumeMixer);
          if (!showVolumeMixer) {
            fetchStreamVolumes();
            fetchRingerMode().catch(err => console.warn("Failed to fetch ringer mode on open:", err));
          }
        }}
        className={isFloating
          ? `p-1.5 border rounded-lg transition-all flex items-center justify-center bg-gray-900/80 border-gray-700/50 text-gray-300 hover:bg-gray-800 ${showVolumeMixer ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-400' : ''}`
          : `px-3 py-1.5 text-xs font-medium border rounded-lg transition-all flex items-center space-x-1.5 bg-gray-800/50 text-gray-400 border-transparent hover:bg-gray-800 ${showVolumeMixer ? 'bg-emerald-950/40 text-emerald-400 border-emerald-900/50' : ''}`
        }
        title="Granular Audio Stream Mixer"
      >
        <SlidersHorizontal className="w-4 h-4" />
        {!isFloating && <span className="text-[10px] font-medium hidden sm:inline">Mixer</span>}
      </button>
      {showVolumeMixer && (
        <div className={`absolute right-0 ${isFloating ? 'top-full mt-2' : 'bottom-full mb-2'} w-72 bg-slate-950/95 backdrop-blur-md border border-slate-800 rounded-xl shadow-2xl p-4 z-50 text-left`}>
          <div className="flex justify-between items-center mb-3 pb-2 border-b border-slate-800/80">
            <div>
              <span className="text-xs font-semibold text-slate-100 block">Device Sound Mixer</span>
              <span className="text-[9px] text-slate-500">Adjust individual audio streams directly</span>
            </div>
            <button 
              onClick={() => {
                fetchStreamVolumes();
                fetchRingerMode().catch(err => console.warn("Failed to fetch ringer mode on sync:", err));
              }}
              className="text-[10px] font-medium bg-slate-900 hover:bg-slate-800 text-emerald-400 px-2 py-1 rounded border border-slate-800 transition-colors"
            >
              Sync
            </button>
          </div>
          
          <div className="mb-4 bg-slate-900/40 p-2 rounded-lg border border-slate-800/60">
            <span className="text-[10px] font-semibold text-slate-400 block mb-1.5 uppercase tracking-wider">Sound Mode</span>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { mode: 2, label: "Sound", icon: <Volume2 className="w-3.5 h-3.5" /> },
                { mode: 1, label: "Vibrate", icon: <Activity className="w-3.5 h-3.5" /> },
                { mode: 0, label: "Silent", icon: <VolumeX className="w-3.5 h-3.5" /> }
              ].map(item => (
                <button
                  key={item.mode}
                  onClick={() => handleSetRingerMode(item.mode)}
                  className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-md border text-[10px] font-medium transition-all ${
                    ringerMode === item.mode 
                      ? "bg-emerald-950/60 border-emerald-500/50 text-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.15)]" 
                      : "bg-slate-950/40 border-slate-800/60 text-slate-400 hover:text-slate-300 hover:border-slate-700/80"
                  }`}
                >
                  {item.icon}
                  <span className="mt-1 text-[9px]">{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3.5">
            {[
              { id: 3, name: 'Media & Music', desc: 'App sounds, video, scrcpy capture', color: 'accent-emerald-500' },
              { id: 2, name: 'Ringtone & Calls', desc: 'Incoming phone calls', color: 'accent-indigo-500' },
              { id: 5, name: 'Notifications', desc: 'Texts and app alerts', color: 'accent-amber-500' },
              { id: 4, name: 'Alarms', desc: 'Clock alarms', color: 'accent-rose-500' },
              { id: 1, name: 'System Sounds', desc: 'Touch feedback, lock sounds', color: 'accent-sky-500' },
            ].map(stream => (
              <div key={stream.id} className="space-y-1">
                <div className="flex justify-between text-[10px]">
                  <div>
                    <span className="font-medium text-slate-300">{stream.name}</span>
                    <span className="text-[8px] text-slate-500 block leading-tight">{stream.desc}</span>
                  </div>
                  <span className="font-mono text-slate-400 font-medium bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800/60 self-start">
                    {streamVolumes[stream.id] ?? 0} / 15
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="15"
                  value={streamVolumes[stream.id] ?? 0}
                  onChange={(e) => handleSetStreamVolume(stream.id, parseInt(e.target.value, 10))}
                  className={`w-full ${stream.color} h-1.5 bg-slate-900 rounded-lg appearance-none cursor-pointer border border-slate-800`}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const renderBackBtn = (isFloating: boolean) => (
    <button
      onClick={() => handleNavAction('back')}
      className={isFloating 
        ? "p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-gray-300 rounded-lg transition-colors flex items-center justify-center"
        : "px-4 py-2 text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/10 rounded-lg transition-colors flex items-center justify-center border border-transparent hover:border-emerald-900/20"
      }
      title="Back"
    >
      <ArrowLeft className={isFloating ? "w-4 h-4" : "w-5 h-5"} />
    </button>
  );

  const renderHomeBtn = (isFloating: boolean) => (
    <button
      onClick={() => handleNavAction('home')}
      className={isFloating 
        ? "p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-gray-300 rounded-lg transition-colors flex items-center justify-center"
        : "px-4 py-2 text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/10 rounded-lg transition-colors flex items-center justify-center border border-transparent hover:border-emerald-900/20"
      }
      title="Home"
    >
      <Circle className={isFloating ? "w-4 h-4 fill-none" : "w-5 h-5 fill-none"} />
    </button>
  );

  const renderRecentsBtn = (isFloating: boolean) => (
    <button
      onClick={() => handleNavAction('appSwitch')}
      className={isFloating 
        ? "p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-gray-300 rounded-lg transition-colors flex items-center justify-center"
        : "px-4 py-2 text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/10 rounded-lg transition-colors flex items-center justify-center border border-transparent hover:border-emerald-900/20"
      }
      title="Recents"
    >
      <Square className={isFloating ? "w-4 h-4 fill-none" : "w-4 h-4 fill-none"} />
    </button>
  );

  const renderDisconnectBtn = (isFloating: boolean) => (
    <button
      onClick={onDisconnect}
      className={isFloating 
        ? "p-1.5 bg-rose-950/80 hover:bg-rose-900/80 border border-rose-500/30 text-rose-300 rounded-lg transition-colors flex items-center justify-center"
        : "px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg shadow transition-colors"
      }
      title="Disconnect Connection"
    >
      {isFloating ? <X className="w-4 h-4" /> : "Disconnect"}
    </button>
  );

  return (
    <div className="flex flex-col items-center justify-center w-full max-w-4xl mx-auto space-y-4">
      {/* Upper Status HUD */}
      <div className="flex flex-wrap items-center justify-between w-full px-4 py-2 text-xs bg-gray-900 border border-gray-800 rounded-lg text-gray-400">
        <div className="flex items-center space-x-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-medium text-gray-200">{deviceName || "Android Device"}</span>
        </div>
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-1">
            <Tv className="w-3.5 h-3.5 text-gray-500" />
            <span>{resolution.width ? `${resolution.width}x${resolution.height}` : "Detecting..."}</span>
          </div>
          <div className="flex items-center space-x-1">
            <Activity className="w-3.5 h-3.5 text-gray-500" />
            <span className="font-mono text-emerald-400 font-semibold">{fps} FPS</span>
          </div>
        </div>
      </div>

      {/* Screen Canvas Container */}
      <div 
        ref={containerRef}
        className={`relative flex items-center justify-center bg-black transition-all duration-300 ${
          isFullscreen 
            ? 'fixed inset-0 z-50 w-screen h-screen rounded-none border-none' 
            : scaleMode === 'center'
              ? 'relative w-fit max-w-full mx-auto max-h-[70vh] rounded-xl overflow-hidden shadow-2xl border border-gray-800'
              : 'relative w-full h-[70vh] rounded-xl overflow-hidden shadow-2xl border border-gray-800'
        }`}
      >
        {error && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-6 bg-gray-950/90 text-center">
            <div className="p-3 mb-4 bg-red-900/30 border border-red-500/50 rounded-full text-red-400">
              <Power className="w-6 h-6 rotate-90" />
            </div>
            <h3 className="text-lg font-semibold text-gray-100">Stream Connection Error</h3>
            <p className="mt-2 text-sm text-gray-400 max-w-md">{error}</p>
            <button 
              onClick={onDisconnect}
              className="mt-6 px-4 py-2 text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors"
            >
              Back to Dashboard
            </button>
          </div>
        )}

        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onTouchStart={handleStartAudioContext}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onContextMenu={async (e) => {
            e.preventDefault();
            if (!client || !client.controller) return;
            try {
              if (client.controller.backOrScreenOn) {
                await client.controller.backOrScreenOn(0); // Down
                await client.controller.backOrScreenOn(1); // Up
              } else {
                handleNavAction('back');
              }
            } catch (err) {
              console.error('Failed to send backOrScreenOn:', err);
            }
          }}
          className={`cursor-pointer transition-all duration-300 select-none ${
            scaleMode === 'center' 
              ? `w-auto h-auto max-w-full object-contain ${isFullscreen ? 'max-h-full' : 'max-h-[70vh]'}` 
              : scaleMode === 'fit' 
                ? 'w-full h-full object-contain' 
                : 'w-full h-full object-fill'
          }`}
          style={{ touchAction: 'none' }}
        />

        <TelemetryHUD 
          adb={adb} 
          isOpen={isTelemetryOpen} 
          onClose={() => setIsTelemetryOpen(false)} 
          containerRef={containerRef}
        />

        {/* Custom On-Screen Volume HUD Overlay */}
        {volumeIndicator && volumeIndicator.visible && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2 z-30 flex flex-col items-center bg-slate-950/90 backdrop-blur-md border border-slate-800/85 rounded-2xl px-3 py-4.5 shadow-2xl transition-all duration-300 w-14">
            <div className="text-[9px] font-bold text-slate-400 rotate-90 origin-center whitespace-nowrap mb-6 mt-2 h-4 flex items-center justify-center tracking-wider uppercase">
              {volumeIndicator.streamId === 3 ? "Media" :
               volumeIndicator.streamId === 2 ? "Ringtone" :
               volumeIndicator.streamId === 5 ? "Notif" :
               volumeIndicator.streamId === 4 ? "Alarm" : "System"}
            </div>
            <div className="relative w-1.5 h-28 bg-slate-900 rounded-full overflow-hidden border border-slate-800 flex flex-col justify-end">
              <div 
                className={`w-full rounded-full transition-all duration-150 ${
                  volumeIndicator.streamId === 3 ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" :
                  volumeIndicator.streamId === 2 ? "bg-indigo-500" :
                  volumeIndicator.streamId === 5 ? "bg-amber-500" :
                  volumeIndicator.streamId === 4 ? "bg-rose-500" : "bg-sky-500"
                }`}
                style={{ height: `${(volumeIndicator.volume / 15) * 100}%` }}
              />
            </div>
            <span className="font-mono text-[10px] font-extrabold text-slate-200 mt-3 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
              {volumeIndicator.volume}
            </span>
          </div>
        )}

          {/* Floating Quick Settings inside canvas area */}
        <div className="absolute top-3 right-3 flex space-x-2 opacity-30 hover:opacity-100 transition-opacity duration-200 z-40">
          <button 
            onClick={() => {
              const current = viewRotationRef.current;
              const next = ((current + 90) % 360) as 0 | 90 | 180 | 270;
              setViewRotation(next);
            }}
            className="p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-emerald-400 rounded-md transition-colors flex items-center justify-center"
            title="Rotate View 90°"
          >
            <RotateCw className="w-4 h-4" />
          </button>
          <button 
            onClick={() => setScaleMode(prev => prev === 'center' ? 'fit' : prev === 'fit' ? 'stretch' : 'center')}
            className={`p-1.5 border rounded-md transition-colors flex items-center justify-center ${
              scaleMode === 'center' 
                ? 'bg-gray-900/80 hover:bg-gray-800 border-gray-700/50' 
                : scaleMode === 'fit' 
                  ? 'bg-emerald-950/80 border-emerald-500/30' 
                  : 'bg-sky-950/80 border-sky-500/30'
            }`}
            title={`Aspect Ratio: ${scaleMode === 'center' ? 'Center' : scaleMode === 'fit' ? 'Fit' : 'Stretch'}`}
          >
            <Tv className={`w-4 h-4 ${
              scaleMode === 'center' 
                ? 'text-slate-400' 
                : scaleMode === 'fit' 
                  ? 'text-emerald-400' 
                  : 'text-sky-400'
            }`} />
          </button>
          <button 
            onClick={toggleFullscreen}
            className="p-1.5 bg-gray-900/80 hover:bg-gray-800 border border-gray-700/50 text-gray-300 rounded-md transition-colors flex items-center justify-center"
            title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>

        {/* Floating Android System Control Bar for Fullscreen mode */}
        {isFullscreen && (
          <div className="absolute top-3 left-3 flex flex-wrap gap-1.5 max-w-[90vw] p-1.5 bg-slate-950/80 backdrop-blur-sm border border-slate-800/80 rounded-xl shadow-2xl opacity-30 hover:opacity-100 transition-opacity duration-200 z-40">
            {renderTelemetryBtn(true)}
            {renderScreenPowerBtn(true)}
            {renderGamepadBtn(true)}
            {renderAudioBtn(true)}
            {renderRingerBtn(true)}
            {renderSpeakerBtn(true)}
            {renderMixerBtn(true)}
            {renderLauncherBtn(true)}
            <div className="w-px h-6 bg-gray-700/50 self-center mx-0.5" />
            {renderPowerBtn(true)}
            {renderVolDownBtn(true)}
            {renderVolUpBtn(true)}
            {renderRotateBtn(true)}
            <div className="w-px h-6 bg-gray-700/50 self-center mx-0.5" />
            {renderBackBtn(true)}
            {renderHomeBtn(true)}
            {renderRecentsBtn(true)}
            <div className="w-px h-6 bg-gray-700/50 self-center mx-0.5" />
            {renderDisconnectBtn(true)}
          </div>
        )}
      </div>

      {/* Primary Android Navigation & Quick Controller Bar */}
      <div className="flex flex-col lg:flex-row items-center justify-between w-full p-4 gap-4 bg-gray-900 border border-gray-800 rounded-xl shadow-lg">
        {/* Left Actions - Power/Volume/Rotation/Launcher */}
        <div className="flex flex-wrap items-center justify-center lg:justify-start gap-2">
          {renderScreenPowerBtn(false)}
          {renderTelemetryBtn(false)}
          {renderGamepadBtn(false)}
          {renderAudioBtn(false)}
          {renderRingerBtn(false)}
          {renderSpeakerBtn(false)}
          {renderMixerBtn(false)}
          <div className="w-px h-6 bg-gray-800 hidden md:block mx-1" />
          {renderPowerBtn(false)}
          {renderVolDownBtn(false)}
          {renderVolUpBtn(false)}
          {renderRotateBtn(false)}
          <div className="w-px h-6 bg-gray-800 hidden md:block mx-1" />
          {renderLauncherBtn(false)}
        </div>

        {/* Center Navigation - Android System Bar */}
        <div className="flex items-center space-x-6">
          {renderBackBtn(false)}
          {renderHomeBtn(false)}
          {renderRecentsBtn(false)}
        </div>

        {/* Right Action - Disconnect */}
        <div className="flex items-center space-x-2">
          {renderDisconnectBtn(false)}
        </div>
      </div>

      {/* Gaming Control Mapping Engine Overlay Panel */}
      {isGamepadEnabled && (
        <GameMappingOverlay 
          client={client} 
          canvasRef={canvasRef} 
          containerRef={containerRef} 
          viewRotation={viewRotation} 
        />
      )}
    </div>
  );
}
