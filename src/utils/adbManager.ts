import { Adb, AdbCredentialStore, AdbPrivateKey, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbWebUsbBackend, AdbWebUsbBackendManager } from '@yume-chan/adb-backend-webusb';
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy';
import { Consumable, ReadableStream } from '@yume-chan/stream-extra';

// Local storage credential store for ADB authorization keys
export class LocalStorageAdbCredentialStore implements AdbCredentialStore {
  async *iterateKeys(): AsyncGenerator<AdbPrivateKey, void, unknown> {
    if (typeof window === 'undefined') return;
    const key = localStorage.getItem('adb_private_key');
    if (key) {
      const binary = atob(key);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      yield { buffer: bytes };
    }
  }

  async generateKey(): Promise<AdbPrivateKey> {
    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: { name: "SHA-1" },
      },
      true,
      ["sign", "verify"]
    );

    const privateKeyBuffer = await window.crypto.subtle.exportKey(
      "pkcs8",
      keyPair.privateKey
    );
    const privateKeyBytes = new Uint8Array(privateKeyBuffer);

    let binary = "";
    for (let i = 0; i < privateKeyBytes.byteLength; i++) {
      binary += String.fromCharCode(privateKeyBytes[i]);
    }
    const base64 = btoa(binary);
    localStorage.setItem("adb_private_key", base64);

    return { buffer: privateKeyBytes };
  }
}

export interface ConnectionState {
  status: 'idle' | 'connecting' | 'connected' | 'authenticating' | 'pushing_server' | 'starting_server' | 'active' | 'disconnected';
  deviceName?: string;
  error?: string;
}

export interface ScrcpySettings {
  videoBitRate?: number;
  maxSize?: number;
  maxFps?: number;
  tunnelForward?: boolean;
  turnScreenOff?: boolean;
  audio?: boolean;
  muteDeviceSpeaker?: boolean;
}

export class AdbManager {
  private adb: Adb | null = null;
  private scrcpyClient: AdbScrcpyClient<any> | null = null;
  private backend: AdbWebUsbBackend | null = null;

  async getPairedDevices(): Promise<AdbWebUsbBackend[]> {
    if (typeof window === 'undefined' || !navigator.usb || !AdbWebUsbBackendManager.BROWSER) return [];
    try {
      return await AdbWebUsbBackendManager.BROWSER.getDevices();
    } catch (e) {
      console.error("Error fetching paired USB devices:", e);
      return [];
    }
  }

  async requestNewDevice(): Promise<AdbWebUsbBackend> {
    if (typeof window === 'undefined' || !navigator.usb || !AdbWebUsbBackendManager.BROWSER) {
      throw new Error("WebUSB API is not supported in this browser or context.");
    }
    const device = await AdbWebUsbBackendManager.BROWSER.requestDevice();
    if (!device) {
      throw new Error("No device was selected or device selection was cancelled.");
    }
    return device;
  }

  async connect(
    backend: AdbWebUsbBackend,
    onStateChange: (state: ConnectionState) => void,
    settings?: ScrcpySettings
  ): Promise<AdbScrcpyClient<any>> {
    try {
      this.backend = backend;
      onStateChange({ status: 'connecting', deviceName: backend.name });

      const connection = await backend.connect();
      onStateChange({ status: 'authenticating', deviceName: backend.name });

      const credentialStore = new LocalStorageAdbCredentialStore();
      const transport = await AdbDaemonTransport.authenticate({
        serial: backend.serial,
        connection: connection as any,
        credentialStore,
      });
      this.adb = new Adb(transport);

      onStateChange({ status: 'connected', deviceName: backend.name });

      // Step 2: Push scrcpy-server.jar
      onStateChange({ status: 'pushing_server', deviceName: backend.name });
      
      let serverBytes: Uint8Array;
      try {
        // Fetch via our Next.js API route proxy to avoid CORS issues from Github
        const response = await fetch('/api/scrcpy?v=3.3.3');
        if (!response.ok) {
          throw new Error(`Failed to fetch proxy server: ${response.status}`);
        }
        serverBytes = new Uint8Array(await response.arrayBuffer());
      } catch (err) {
        console.warn("Could not load scrcpy-server from API proxy", err);
        throw new Error("Could not download scrcpy-server for injection. Please check internet connection.");
      }

      // Push to /data/local/tmp/scrcpy-server.jar
      const sync = await this.adb.sync();
      try {
        await sync.write({
          filename: '/data/local/tmp/scrcpy-server.jar',
          file: new ReadableStream<Consumable<Uint8Array>>({
            start(controller) {
              controller.enqueue(new Consumable(serverBytes));
              controller.close();
            }
          }),
        });
      } finally {
        await sync.dispose();
      }

      // Step 3: Start Scrcpy Server
      onStateChange({ status: 'starting_server', deviceName: backend.name });

      // Instantiate options for scrcpy (compatible with v3.3)
      const options = new AdbScrcpyOptionsLatest(
        AdbScrcpyOptionsLatest.Defaults
      );
      // Override specific defaults for performance and compatibility (especially Moto G85 / Android 14+)
      options.value.logLevel = "debug";
      options.value.videoCodec = "h264";
      options.value.videoBitRate = settings?.videoBitRate ?? 2000000;
      options.value.maxSize = settings?.maxSize ?? 800;
      options.value.maxFps = settings?.maxFps ?? 30;
      options.value.audio = settings?.audio ?? true;
      (options.value as any).audioSource = "playback";
      options.value.tunnelForward = settings?.tunnelForward ?? true;
      (options.value as any).turnScreenOff = settings?.turnScreenOff ?? false;
      options.value.displayId = 0; // Force main display to fix Motorola "Ready For" bug
      options.value.clipboardAutosync = false; // Disable clipboard sync for Android 14 security

      this.scrcpyClient = await AdbScrcpyClient.start(
        this.adb,
        '/data/local/tmp/scrcpy-server.jar',
        options
      );

      // Consume and log the scrcpy server output so we can see any encoder errors on the device
      if (this.scrcpyClient.output) {
        this.scrcpyClient.output.pipeTo(new WritableStream({
          write(chunk) {
            console.log('[scrcpy-server]', chunk);
          }
        }) as any).catch((e) => {
          console.warn('scrcpy-server output stream closed', e);
        });
      }

      onStateChange({ status: 'active', deviceName: backend.name });
      return this.scrcpyClient;

    } catch (error: any) {
      console.error("Scrcpy failed to start. Full details:", error);
      
      // If the error contains server output lines, print them out clearly
      if (error.output) {
        console.error("Android Server Log:", error.output.join('\n'));
      }
      
      const errorMessage = error.output ? error.output.join(' | ') : (error?.message || String(error));
      
      onStateChange({
        status: 'disconnected',
        error: errorMessage,
      });
      await this.disconnect();
      throw error;
    }
  }

  async disconnect() {
    try {
      if (this.scrcpyClient) {
        if (typeof (this.scrcpyClient as any).close === 'function') {
          await (this.scrcpyClient as any).close();
        } else if (typeof (this.scrcpyClient as any).dispose === 'function') {
          await (this.scrcpyClient as any).dispose();
        }
        this.scrcpyClient = null;
      }
      if (this.adb) {
        await this.adb.close();
        this.adb = null;
      }
      
      // Explicitly close the WebUSB device if it was left open
      if (this.backend && this.backend.device) {
        try {
          if (this.backend.device.opened) {
            await this.backend.device.close();
          }
        } catch (deviceCloseError) {
          console.warn("Failed to close underlying WebUSB device:", deviceCloseError);
        }
      }
      this.backend = null;
    } catch (e) {
      console.error("Error during disconnect:", e);
    }
  }

  getAdb(): Adb | null {
    return this.adb;
  }

  async executeShell(command: string): Promise<string> {
    if (!this.adb) {
      throw new Error("No active ADB connection");
    }
    return await this.adb.subprocess.noneProtocol.spawnWaitText(command);
  }

  async getInstalledApps(): Promise<string[]> {
    if (!this.adb) {
      throw new Error("No active ADB connection");
    }
    try {
      // Use spawnWaitText to run the command and get output as string
      const output = await this.adb.subprocess.noneProtocol.spawnWaitText("cmd package list packages -3");
      const apps = output.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('package:'))
        .map(line => line.replace('package:', ''));
      return apps.sort();
    } catch (e) {
      console.error("Failed to list apps:", e);
      return [];
    }
  }

  async launchApp(packageName: string): Promise<void> {
    if (!this.adb) {
      throw new Error("No active ADB connection");
    }
    try {
      await this.adb.subprocess.noneProtocol.spawnWaitText(
        `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`
      );
    } catch (e) {
      console.error(`Failed to launch app ${packageName}:`, e);
    }
  }
}
