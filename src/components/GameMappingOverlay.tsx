'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { 
  Plus, 
  Trash2, 
  Settings, 
  Download, 
  Upload, 
  Play, 
  Square, 
  X, 
  Info, 
  Gamepad, 
  Check, 
  AlertCircle,
  HelpCircle,
  ChevronRight,
  ChevronLeft,
  Sliders,
  Maximize2
} from 'lucide-react';

export interface KeyControl {
  id: string;
  type: 'JOYSTICK' | 'TAP' | 'SWIPE';
  name: string;
  pointerId: number;
  // JOYSTICK keys
  keys?: {
    up: string;
    down: string;
    left: string;
    right: string;
  };
  center?: { x: number; y: number }; // Relative percentage (0-1) in unrotated space
  radius?: number; // visual/movement radius in pixels (e.g. 80)
  // TAP keys
  key?: string;
  position?: { x: number; y: number }; // Relative percentage (0-1) in unrotated space
  // SWIPE keys
  startPosition?: { x: number; y: number }; // Relative percentage (0-1) in unrotated space
  direction?: { x: number; y: number }; // pixel delta offset, e.g. {x: 0, y: -100}
}

export interface MappingProfile {
  profileName: string;
  resolution: { width: number; height: number };
  controls: KeyControl[];
}

interface GameMappingOverlayProps {
  client: any;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewRotation: number;
}

// Default eFootball Mobile controller profile
const DEFAULT_EFOOTBALL_PROFILE: MappingProfile = {
  profileName: "eFootball Mobile Profile",
  resolution: { width: 2400, height: 1080 },
  controls: [
    {
      id: "ef_joystick",
      type: "JOYSTICK",
      name: "Movement Joystick",
      pointerId: 1,
      center: { x: 0.15, y: 0.72 },
      radius: 80,
      keys: { up: "w", down: "s", left: "a", right: "d" }
    },
    {
      id: "ef_dash",
      type: "TAP",
      name: "Sprint / Dash",
      pointerId: 2,
      position: { x: 0.85, y: 0.80 },
      key: "shift"
    },
    {
      id: "ef_pass",
      type: "TAP",
      name: "Pass / Press",
      pointerId: 3,
      position: { x: 0.76, y: 0.88 },
      key: "j"
    },
    {
      id: "ef_through",
      type: "SWIPE",
      name: "Through Pass (Swipe Up)",
      pointerId: 4,
      startPosition: { x: 0.83, y: 0.76 },
      direction: { x: 0, y: -90 },
      key: "i"
    },
    {
      id: "ef_shoot",
      type: "TAP",
      name: "Shoot / Match-Up",
      pointerId: 5,
      position: { x: 0.88, y: 0.65 },
      key: "l"
    },
    {
      id: "ef_shield",
      type: "TAP",
      name: "Shield",
      pointerId: 6,
      position: { x: 0.94, y: 0.78 },
      key: "k"
    }
  ]
};

// Available Android motion event action constants
const MOTION_ACTION_DOWN = 0;
const MOTION_ACTION_UP = 1;
const MOTION_ACTION_MOVE = 2;

export default function GameMappingOverlay({ 
  client, 
  canvasRef, 
  containerRef,
  viewRotation 
}: GameMappingOverlayProps) {
  const [profiles, setProfiles] = useState<MappingProfile[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem("adb_game_mapping_profiles");
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        } catch (e) {
          console.error("Failed to parse saved mapping profiles:", e);
        }
      }
    }
    return [DEFAULT_EFOOTBALL_PROFILE];
  });
  
  const [activeProfileIdx, setActiveProfileIdx] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isEditMode, setIsEditMode] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null);
  const [draggingControlId, setDraggingControlId] = useState<string | null>(null);
  
  // Track visual offset for active on-screen joystick dragging
  const [joystickOffsets, setJoystickOffsets] = useState<Record<string, { x: number; y: number }>>({});

  const [canvasLayout, setCanvasLayout] = useState<{
    width: number;
    height: number;
    left: number;
    top: number;
    leftOffset: number;
    topOffset: number;
  } | null>(null);

  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);

  // Keyboard capture references
  const activeKeysRef = useRef<Set<string>>(new Set());
  const tickIntervalRef = useRef<any>(null);
  const controlStatesRef = useRef<Record<string, { isTracking: boolean; lastX?: number; lastY?: number }>>({});
  const assignedPointerSlotsRef = useRef<Record<string, number>>({});

  const acquirePointerSlot = useCallback((controlId: string): number => {
    if (assignedPointerSlotsRef.current[controlId] !== undefined) {
      return assignedPointerSlotsRef.current[controlId];
    }
    const activeSlots = Object.values(assignedPointerSlotsRef.current);
    let slot = 0;
    while (activeSlots.includes(slot)) {
      slot++;
    }
    assignedPointerSlotsRef.current[controlId] = slot;
    return slot;
  }, []);

  const releasePointerSlot = useCallback((controlId: string) => {
    delete assignedPointerSlotsRef.current[controlId];
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const currentProfile = profiles[activeProfileIdx] || DEFAULT_EFOOTBALL_PROFILE;

  // Track layout dimensions of the canvas relative to the bounding container
  const updateLayout = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    setCanvasLayout({
      width: canvasRect.width,
      height: canvasRect.height,
      left: canvasRect.left,
      top: canvasRect.top,
      leftOffset: canvasRect.left - containerRect.left,
      topOffset: canvasRect.top - containerRect.top,
    });
  }, [canvasRef, containerRef]);

  // Update layout when canvas changes or on resize/intervals
  useEffect(() => {
    if (containerRef.current) {
      setContainerEl(containerRef.current);
    }
    updateLayout();
    window.addEventListener('resize', updateLayout);
    const interval = setInterval(updateLayout, 1000);
    return () => {
      window.removeEventListener('resize', updateLayout);
      clearInterval(interval);
    };
  }, [updateLayout, containerRef]);

  // Listen to keyboard globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is editing text inputs
      if (
        document.activeElement?.tagName === 'INPUT' || 
        document.activeElement?.tagName === 'TEXTAREA' ||
        document.activeElement?.getAttribute('contenteditable') === 'true'
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      activeKeysRef.current.add(key);

      // Prevent default scrolling keys during gameplay mapping
      if (isPlaying && [" ", "arrowup", "arrowdown", "arrowleft", "arrowright", "tab"].includes(e.key)) {
        e.preventDefault();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      activeKeysRef.current.delete(key);
    };

    const handleBlur = () => {
      activeKeysRef.current.clear();
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
      window.removeEventListener('blur', handleBlur);
    };
  }, [isPlaying]);

  // Save profiles to localStorage
  const saveProfilesToStorage = (updatedProfiles: MappingProfile[]) => {
    setProfiles(updatedProfiles);
    localStorage.setItem("adb_game_mapping_profiles", JSON.stringify(updatedProfiles));
  };

  // Swipe gesture execution pipeline
   const executeSwipe = useCallback(async (control: KeyControl, origWidth: number, origHeight: number) => {
    if (!client?.controller?.injectTouch || !control.startPosition || !control.direction) return;

    const startX = control.startPosition.x * origWidth;
    const startY = control.startPosition.y * origHeight;
    const endX = startX + (control.direction.x || 0);
    const endY = startY + (control.direction.y || 0);

    const steps = 8;
    const stepDelayMs = 15;
    
    const slot = acquirePointerSlot(control.id);
    const pointerId = BigInt(slot);

    try {
      // 1. Touch Down
      await client.controller.injectTouch({
        action: MOTION_ACTION_DOWN,
        pointerId,
        pointerX: startX,
        pointerY: startY,
        videoWidth: origWidth,
        videoHeight: origHeight,
        pressure: 1,
        actionButton: 0,
        buttons: 1
      });

      // 2. Interpolate Swipes
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const currentX = startX + (endX - startX) * t;
        const currentY = startY + (endY - startY) * t;

        await new Promise(resolve => setTimeout(resolve, stepDelayMs));

        await client.controller.injectTouch({
          action: MOTION_ACTION_MOVE,
          pointerId,
          pointerX: currentX,
          pointerY: currentY,
          videoWidth: origWidth,
          videoHeight: origHeight,
          pressure: 1,
          actionButton: 0,
          buttons: 1
        });
      }

      // 3. Touch Up
      await client.controller.injectTouch({
        action: MOTION_ACTION_UP,
        pointerId,
        pointerX: endX,
        pointerY: endY,
        videoWidth: origWidth,
        videoHeight: origHeight,
        pressure: 0,
        actionButton: 0,
        buttons: 0
      });
    } catch (err) {
      console.warn("Failed to inject swipe macro stream:", err);
    } finally {
      releasePointerSlot(control.id);
    }
  }, [client, acquirePointerSlot, releasePointerSlot]);

  // Main 60Hz Input state polling processor
  const processTick = useCallback(() => {
    if (!client?.controller?.injectTouch || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const isRotated = viewRotation === 90 || viewRotation === 270;
    const origWidth = isRotated ? canvas.height : canvas.width;
    const origHeight = isRotated ? canvas.width : canvas.height;

    currentProfile.controls.forEach((control) => {
      const state = controlStatesRef.current[control.id] || { isTracking: false };
      controlStatesRef.current[control.id] = state;

      if (control.type === 'JOYSTICK' && control.center && control.keys) {
        let dx = 0;
        let dy = 0;

        if (activeKeysRef.current.has(control.keys.up.toLowerCase())) dy -= 1;
        if (activeKeysRef.current.has(control.keys.down.toLowerCase())) dy += 1;
        if (activeKeysRef.current.has(control.keys.left.toLowerCase())) dx -= 1;
        if (activeKeysRef.current.has(control.keys.right.toLowerCase())) dx += 1;

        const centerScrcpyX = control.center.x * origWidth;
        const centerScrcpyY = control.center.y * origHeight;

        if (dx !== 0 || dy !== 0) {
          // Rotate keyboard vector according to view rotation so that visually UP is always UP
          let dx_rot = dx;
          let dy_rot = dy;
          const rot = viewRotation;
          if (rot === 90) {
            dx_rot = dy;
            dy_rot = -dx;
          } else if (rot === 180) {
            dx_rot = -dx;
            dy_rot = -dy;
          } else if (rot === 270) {
            dx_rot = -dy;
            dy_rot = dx;
          }

          const length = Math.sqrt(dx_rot * dx_rot + dy_rot * dy_rot);
          const normX = dx_rot / length;
          const normY = dy_rot / length;
          const radius = control.radius || 80;

          const targetX = centerScrcpyX + normX * radius;
          const targetY = centerScrcpyY + normY * radius;

          const slot = acquirePointerSlot(control.id);
          const pointerId = BigInt(slot);

          if (!state.isTracking) {
            // First send Touch Down at the joystick center, then drag
            client.controller.injectTouch({
              action: MOTION_ACTION_DOWN,
              pointerId,
              pointerX: centerScrcpyX,
              pointerY: centerScrcpyY,
              videoWidth: origWidth,
              videoHeight: origHeight,
              pressure: 1,
              actionButton: 0,
              buttons: 1
            }).then(() => {
              client.controller.injectTouch({
                action: MOTION_ACTION_MOVE,
                pointerId,
                pointerX: targetX,
                pointerY: targetY,
                videoWidth: origWidth,
                videoHeight: origHeight,
                pressure: 1,
                actionButton: 0,
                buttons: 1
              });
            });
            state.isTracking = true;
            state.lastX = targetX;
            state.lastY = targetY;
          } else {
            // Continuous Touch Moves
            client.controller.injectTouch({
              action: MOTION_ACTION_MOVE,
              pointerId,
              pointerX: targetX,
              pointerY: targetY,
              videoWidth: origWidth,
              videoHeight: origHeight,
              pressure: 1,
              actionButton: 0,
              buttons: 1
            });
            state.lastX = targetX;
            state.lastY = targetY;
          }
        } else {
          // No joystick keys are pressed
          if (state.isTracking) {
            const slot = acquirePointerSlot(control.id);
            const pointerId = BigInt(slot);
            client.controller.injectTouch({
              action: MOTION_ACTION_UP,
              pointerId,
              pointerX: state.lastX ?? centerScrcpyX,
              pointerY: state.lastY ?? centerScrcpyY,
              videoWidth: origWidth,
              videoHeight: origHeight,
              pressure: 0,
              actionButton: 0,
              buttons: 0
            });
            state.isTracking = false;
            releasePointerSlot(control.id);
          }
        }
      } else if (control.type === 'TAP' && control.position && control.key) {
        const isPressed = activeKeysRef.current.has(control.key.toLowerCase());
        const tapX = control.position.x * origWidth;
        const tapY = control.position.y * origHeight;

        const slot = acquirePointerSlot(control.id);
        const pointerId = BigInt(slot);

        if (isPressed) {
          if (!state.isTracking) {
            client.controller.injectTouch({
              action: MOTION_ACTION_DOWN,
              pointerId,
              pointerX: tapX,
              pointerY: tapY,
              videoWidth: origWidth,
              videoHeight: origHeight,
              pressure: 1,
              actionButton: 0,
              buttons: 1
            });
            state.isTracking = true;
          }
        } else {
          if (state.isTracking) {
            client.controller.injectTouch({
              action: MOTION_ACTION_UP,
              pointerId,
              pointerX: tapX,
              pointerY: tapY,
              videoWidth: origWidth,
              videoHeight: origHeight,
              pressure: 0,
              actionButton: 0,
              buttons: 0
            });
            state.isTracking = false;
            releasePointerSlot(control.id);
          }
        }
      } else if (control.type === 'SWIPE' && control.startPosition && control.key) {
        const isPressed = activeKeysRef.current.has(control.key.toLowerCase());
        if (isPressed) {
          if (!state.isTracking) {
            state.isTracking = true;
            executeSwipe(control, origWidth, origHeight);
          }
        } else {
          if (state.isTracking) {
            state.isTracking = false;
          }
        }
      }
    });
  }, [client, currentProfile, viewRotation, canvasRef, executeSwipe, acquirePointerSlot, releasePointerSlot]);

  // Start / Stop Tick loop
  useEffect(() => {
    if (isPlaying) {
      activeKeysRef.current.clear();
      controlStatesRef.current = {};
      tickIntervalRef.current = setInterval(processTick, 16.67); // 60Hz tick rate
      console.log("[WebADB-Gamepad] Macro worker loop launched at 60Hz");
    } else {
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }
      // Clean up any remaining touch active points
      if (client?.controller?.injectTouch && canvasRef.current) {
        const canvas = canvasRef.current;
        const isRotated = viewRotation === 90 || viewRotation === 270;
        const origWidth = isRotated ? canvas.height : canvas.width;
        const origHeight = isRotated ? canvas.width : canvas.height;

        currentProfile.controls.forEach((control) => {
          const state = controlStatesRef.current[control.id];
          if (state && state.isTracking) {
            const slot = acquirePointerSlot(control.id);
            const pointerId = BigInt(slot);
            const x = (control.position?.x ?? control.center?.x ?? control.startPosition?.x ?? 0.5) * origWidth;
            const y = (control.position?.y ?? control.center?.y ?? control.startPosition?.y ?? 0.5) * origHeight;

            client.controller.injectTouch({
              action: MOTION_ACTION_UP,
              pointerId,
              pointerX: x,
              pointerY: y,
              videoWidth: origWidth,
              videoHeight: origHeight,
              pressure: 0,
              actionButton: 0,
              buttons: 0
            }).catch(() => {});
            releasePointerSlot(control.id);
          }
        });
      }
      controlStatesRef.current = {};
    }

    return () => {
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
      }
    };
  }, [isPlaying, processTick, client, currentProfile, viewRotation, canvasRef, acquirePointerSlot, releasePointerSlot]);

  // Map unrotated relative coords [0,1] to visual absolute layout px on the bounding client-box
  const getVisualPosition = (relX: number, relY: number) => {
    if (!canvasLayout) return { x: 0, y: 0 };

    const rot = viewRotation;
    let visualX = relX;
    let visualY = relY;

    // Convert from unrotated space back to rotated space
    if (rot === 90) {
      visualX = relY;
      visualY = 1.0 - relX;
    } else if (rot === 180) {
      visualX = 1.0 - relX;
      visualY = 1.0 - relY;
    } else if (rot === 270) {
      visualX = 1.0 - relY;
      visualY = relX;
    }

    // Convert relative to layout pixels (within the overlay div, which has size width x height)
    const pxX = visualX * canvasLayout.width;
    const pxY = visualY * canvasLayout.height;

    return { x: pxX, y: pxY };
  };

  // Convert visual absolute layout px on the canvas bounding box to unrotated relative coordinates [0,1]
  const getRelativePosition = (clientX: number, clientY: number) => {
    if (!canvasLayout) return { x: 0.5, y: 0.5 };

    // Get position relative to the overlay div's bounding box (which is canvasLayout)
    const relLayoutX = clientX - canvasLayout.left;
    const relLayoutY = clientY - canvasLayout.top;

    // Normalize to visual bounds percentage
    const visualX = Math.max(0, Math.min(1, relLayoutX / canvasLayout.width));
    const visualY = Math.max(0, Math.min(1, relLayoutY / canvasLayout.height));

    // Map rotated visual coordinates back to unrotated native coordinates
    const rot = viewRotation;
    let relX = visualX;
    let relY = visualY;

    if (rot === 90) {
      relX = 1.0 - visualY;
      relY = visualX;
    } else if (rot === 180) {
      relX = 1.0 - visualX;
      relY = 1.0 - visualY;
    } else if (rot === 270) {
      relX = visualY;
      relY = 1.0 - visualX;
    }

    return { x: parseFloat(relX.toFixed(4)), y: parseFloat(relY.toFixed(4)) };
  };

  // DRAG AND DROP - Handle Pointer event dragging on visual indicators in edit mode
  const handleIndicatorPointerDown = (e: React.PointerEvent, ctrlId: string) => {
    if (!isEditMode) return;
    e.stopPropagation();
    setSelectedControlId(ctrlId);
    setDraggingControlId(ctrlId);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleIndicatorPointerMove = (e: React.PointerEvent) => {
    if (!isEditMode || !draggingControlId) return;
    e.stopPropagation();
    
    const relCoords = getRelativePosition(e.clientX, e.clientY);
    const updatedControls = currentProfile.controls.map((ctrl) => {
      if (ctrl.id === draggingControlId) {
        if (ctrl.type === 'JOYSTICK') {
          return { ...ctrl, center: relCoords };
        } else if (ctrl.type === 'TAP') {
          return { ...ctrl, position: relCoords };
        } else if (ctrl.type === 'SWIPE') {
          return { ...ctrl, startPosition: relCoords };
        }
      }
      return ctrl;
    });

    const updatedProfiles = profiles.map((p, idx) => 
      idx === activeProfileIdx ? { ...p, controls: updatedControls } : p
    );
    setProfiles(updatedProfiles);
  };

  const handleIndicatorPointerUp = (e: React.PointerEvent) => {
    if (!isEditMode || !draggingControlId) return;
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch (err) {}
    setDraggingControlId(null);
    // Persist to localStorage on release
    localStorage.setItem("adb_game_mapping_profiles", JSON.stringify(profiles));
  };

  // Click on background in edit mode to teleport selected indicator
  const handleOverlayCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isEditMode || draggingControlId) return;

    if (selectedControlId) {
      const relCoords = getRelativePosition(e.clientX, e.clientY);
      const updatedControls = currentProfile.controls.map((ctrl) => {
        if (ctrl.id === selectedControlId) {
          if (ctrl.type === 'JOYSTICK') {
            return { ...ctrl, center: relCoords };
          } else if (ctrl.type === 'TAP') {
            return { ...ctrl, position: relCoords };
          } else if (ctrl.type === 'SWIPE') {
            return { ...ctrl, startPosition: relCoords };
          }
        }
        return ctrl;
      });

      const updatedProfiles = profiles.map((p, idx) => 
        idx === activeProfileIdx ? { ...p, controls: updatedControls } : p
      );
      saveProfilesToStorage(updatedProfiles);
    }
  };

  // TOUCH PLAY - Handle real-time touch action injection when clicking/touching buttons on overlay
  const handleVirtualTapPointerDown = async (e: React.PointerEvent, ctrl: KeyControl) => {
    if (!isPlaying || !client?.controller?.injectTouch || !canvasRef.current) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const canvas = canvasRef.current;
    const isRotated = viewRotation === 90 || viewRotation === 270;
    const origWidth = isRotated ? canvas.height : canvas.width;
    const origHeight = isRotated ? canvas.width : canvas.height;

    const slot = acquirePointerSlot(ctrl.id);
    const pointerId = BigInt(slot);
    const pos = ctrl.position || { x: 0.5, y: 0.5 };
    const tapX = pos.x * origWidth;
    const tapY = pos.y * origHeight;

    try {
      await client.controller.injectTouch({
        action: MOTION_ACTION_DOWN,
        pointerId,
        pointerX: tapX,
        pointerY: tapY,
        videoWidth: origWidth,
        videoHeight: origHeight,
        pressure: 1,
        actionButton: 0,
        buttons: 1
      });
    } catch (err) {
      console.warn("Failed virtual tap down:", err);
    }
  };

  const handleVirtualTapPointerUp = async (e: React.PointerEvent, ctrl: KeyControl) => {
    if (!isPlaying || !client?.controller?.injectTouch || !canvasRef.current) return;
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch (err) {}

    const canvas = canvasRef.current;
    const isRotated = viewRotation === 90 || viewRotation === 270;
    const origWidth = isRotated ? canvas.height : canvas.width;
    const origHeight = isRotated ? canvas.width : canvas.height;

    const slot = acquirePointerSlot(ctrl.id);
    const pointerId = BigInt(slot);
    const pos = ctrl.position || { x: 0.5, y: 0.5 };
    const tapX = pos.x * origWidth;
    const tapY = pos.y * origHeight;

    try {
      await client.controller.injectTouch({
        action: MOTION_ACTION_UP,
        pointerId,
        pointerX: tapX,
        pointerY: tapY,
        videoWidth: origWidth,
        videoHeight: origHeight,
        pressure: 0,
        actionButton: 0,
        buttons: 0
      });
    } catch (err) {
      console.warn("Failed virtual tap up:", err);
    } finally {
      releasePointerSlot(ctrl.id);
    }
  };

  const handleVirtualJoyPointerDown = async (e: React.PointerEvent, ctrl: KeyControl) => {
    if (!isPlaying || !client?.controller?.injectTouch || !canvasRef.current) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const canvas = canvasRef.current;
    const isRotated = viewRotation === 90 || viewRotation === 270;
    const origWidth = isRotated ? canvas.height : canvas.width;
    const origHeight = isRotated ? canvas.width : canvas.height;

    const slot = acquirePointerSlot(ctrl.id);
    const pointerId = BigInt(slot);
    const center = ctrl.center || { x: 0.5, y: 0.5 };
    const centerScrcpyX = center.x * origWidth;
    const centerScrcpyY = center.y * origHeight;

    try {
      await client.controller.injectTouch({
        action: MOTION_ACTION_DOWN,
        pointerId,
        pointerX: centerScrcpyX,
        pointerY: centerScrcpyY,
        videoWidth: origWidth,
        videoHeight: origHeight,
        pressure: 1,
        actionButton: 0,
        buttons: 1
      });
    } catch (err) {
      console.warn("Failed virtual joy down:", err);
    }
  };

  const handleVirtualJoyPointerMove = async (e: React.PointerEvent, ctrl: KeyControl) => {
    if (!isPlaying || !client?.controller?.injectTouch || !canvasRef.current || !canvasLayout) return;
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    e.stopPropagation();

    const canvas = canvasRef.current;
    const isRotated = viewRotation === 90 || viewRotation === 270;
    const origWidth = isRotated ? canvas.height : canvas.width;
    const origHeight = isRotated ? canvas.width : canvas.height;

    const slot = acquirePointerSlot(ctrl.id);
    const pointerId = BigInt(slot);
    const center = ctrl.center || { x: 0.5, y: 0.5 };

    // Get the visual position of the joystick center on screen
    const centerVisual = getVisualPosition(center.x, center.y);

    // Calculate delta in layout pixels
    const deltaX = e.clientX - canvasLayout.left - centerVisual.x;
    const deltaY = e.clientY - canvasLayout.top - centerVisual.y;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    const radius = ctrl.radius || 80;
    let limitX = deltaX;
    let limitY = deltaY;

    if (distance > radius) {
      limitX = (deltaX / distance) * radius;
      limitY = (deltaY / distance) * radius;
    }

    // Update state to render the joystick knob shifted
    setJoystickOffsets(prev => ({
      ...prev,
      [ctrl.id]: { x: limitX, y: limitY }
    }));

    // Convert the offset back to scrcpy coordinates
    const scaleX = origWidth / canvasLayout.width;
    const scaleY = origHeight / canvasLayout.height;

    const rot = viewRotation;
    let offsetScrcpyX = limitX;
    let offsetScrcpyY = limitY;

    // Convert from rotated visual offset to unrotated native offset
    if (rot === 90) {
      offsetScrcpyX = limitY;
      offsetScrcpyY = -limitX;
    } else if (rot === 180) {
      offsetScrcpyX = -limitX;
      offsetScrcpyY = -limitY;
    } else if (rot === 270) {
      offsetScrcpyX = -limitY;
      offsetScrcpyY = limitX;
    }

    const finalX = (center.x * origWidth) + (offsetScrcpyX * scaleX);
    const finalY = (center.y * origHeight) + (offsetScrcpyY * scaleY);

    try {
      await client.controller.injectTouch({
        action: MOTION_ACTION_MOVE,
        pointerId,
        pointerX: finalX,
        pointerY: finalY,
        videoWidth: origWidth,
        videoHeight: origHeight,
        pressure: 1,
        actionButton: 0,
        buttons: 1
      });
    } catch (err) {
      console.warn("Failed virtual joy move:", err);
    }
  };

  const handleVirtualJoyPointerUp = async (e: React.PointerEvent, ctrl: KeyControl) => {
    if (!isPlaying || !client?.controller?.injectTouch || !canvasRef.current) return;
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch (err) {}

    setJoystickOffsets(prev => ({
      ...prev,
      [ctrl.id]: { x: 0, y: 0 }
    }));

    const canvas = canvasRef.current;
    const isRotated = viewRotation === 90 || viewRotation === 270;
    const origWidth = isRotated ? canvas.height : canvas.width;
    const origHeight = isRotated ? canvas.width : canvas.height;

    const slot = acquirePointerSlot(ctrl.id);
    const pointerId = BigInt(slot);
    const center = ctrl.center || { x: 0.5, y: 0.5 };
    const centerScrcpyX = center.x * origWidth;
    const centerScrcpyY = center.y * origHeight;

    try {
      await client.controller.injectTouch({
        action: MOTION_ACTION_UP,
        pointerId,
        pointerX: centerScrcpyX,
        pointerY: centerScrcpyY,
        videoWidth: origWidth,
        videoHeight: origHeight,
        pressure: 0,
        actionButton: 0,
        buttons: 0
      });
    } catch (err) {
      console.warn("Failed virtual joy up:", err);
    } finally {
      releasePointerSlot(ctrl.id);
    }
  };

  const handleVirtualSwipePointerDown = async (e: React.PointerEvent, ctrl: KeyControl) => {
    if (!isPlaying || !client?.controller?.injectTouch || !canvasRef.current) return;
    e.stopPropagation();

    const canvas = canvasRef.current;
    const isRotated = viewRotation === 90 || viewRotation === 270;
    const origWidth = isRotated ? canvas.height : canvas.width;
    const origHeight = isRotated ? canvas.width : canvas.height;

    // Execute swipe macro sequence asynchronously
    executeSwipe(ctrl, origWidth, origHeight);
  };

  // Add a new mapping control
  const handleAddControl = (type: 'JOYSTICK' | 'TAP' | 'SWIPE') => {
    const newId = `ctrl_${Date.now()}`;
    const nextPointerId = Math.max(...currentProfile.controls.map(c => c.pointerId), 0) + 1;

    const newCtrl: KeyControl = {
      id: newId,
      type,
      name: `New ${type === 'JOYSTICK' ? 'Joystick' : type === 'TAP' ? 'Tap Key' : 'Swipe Macro'}`,
      pointerId: nextPointerId,
      ...(type === 'JOYSTICK' ? {
        center: { x: 0.5, y: 0.5 },
        radius: 80,
        keys: { up: 'w', down: 's', left: 'a', right: 'd' }
      } : type === 'TAP' ? {
        position: { x: 0.5, y: 0.5 },
        key: 'space'
      } : {
        startPosition: { x: 0.5, y: 0.5 },
        direction: { x: 0, y: -80 },
        key: 'q'
      })
    };

    const updatedControls = [...currentProfile.controls, newCtrl];
    const updatedProfiles = profiles.map((p, idx) => 
      idx === activeProfileIdx ? { ...p, controls: updatedControls } : p
    );
    saveProfilesToStorage(updatedProfiles);
    setSelectedControlId(newId);
  };

  // Delete a control
  const handleDeleteControl = (id: string) => {
    const updatedControls = currentProfile.controls.filter((ctrl) => ctrl.id !== id);
    const updatedProfiles = profiles.map((p, idx) => 
      idx === activeProfileIdx ? { ...p, controls: updatedControls } : p
    );
    saveProfilesToStorage(updatedProfiles);
    if (selectedControlId === id) {
      setSelectedControlId(null);
    }
  };

  // Update specific field in a control
  const handleUpdateControlValue = (id: string, keyName: keyof KeyControl, value: any) => {
    const updatedControls = currentProfile.controls.map((ctrl) => {
      if (ctrl.id === id) {
        return { ...ctrl, [keyName]: value };
      }
      return ctrl;
    });

    const updatedProfiles = profiles.map((p, idx) => 
      idx === activeProfileIdx ? { ...p, controls: updatedControls } : p
    );
    saveProfilesToStorage(updatedProfiles);
  };

  // Export profile JSON
  const handleExportProfile = () => {
    const blob = new Blob([JSON.stringify(currentProfile, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentProfile.profileName.replace(/\s+/g, "_")}_mapping.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Import profile JSON
  const handleImportProfile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target?.result as string);
        if (imported && imported.profileName && Array.isArray(imported.controls)) {
          const updated = [...profiles, imported];
          saveProfilesToStorage(updated);
          setActiveProfileIdx(updated.length - 1);
          alert(`Successfully imported "${imported.profileName}"!`);
        } else {
          alert("Invalid mapping profile JSON structure.");
        }
      } catch (err) {
        alert("Failed to parse JSON file.");
      }
    };
    reader.readAsText(file);
  };

  const createNewProfile = () => {
    const name = prompt("Enter a name for the new profile:", "Custom Game Profile");
    if (!name) return;

    const newProf: MappingProfile = {
      profileName: name,
      resolution: { width: 2400, height: 1080 },
      controls: []
    };

    const updated = [...profiles, newProf];
    saveProfilesToStorage(updated);
    setActiveProfileIdx(updated.length - 1);
  };

  const selectedControl = currentProfile.controls.find(c => c.id === selectedControlId);

  // If containerEl is not ready, we cannot draw overlay portals
  if (!containerEl) return null;

  return createPortal(
    <>
      {/* Floating Toggle Launcher Button - Pinned at bottom left of screen area */}
      <button
        onClick={() => {
          setIsSidebarOpen(!isSidebarOpen);
          updateLayout();
        }}
        className={`absolute bottom-4 left-4 z-40 p-2.5 rounded-full shadow-2xl transition-all flex items-center justify-center pointer-events-auto border ${
          isSidebarOpen 
            ? 'bg-rose-950/90 hover:bg-rose-900 border-rose-500/50 text-rose-400' 
            : 'bg-slate-900/90 hover:bg-slate-800 border-slate-700/80 text-emerald-400 hover:text-emerald-300 hover:scale-105'
        }`}
        title="Toggle Game Mapping Controller Panel"
      >
        <Gamepad className="w-5 h-5" />
        <span className="text-[10px] font-bold ml-1.5 hidden sm:inline">GAMEPAD ENG</span>
      </button>

      {/* Floating Glassmorphic Slide-in Drawer overlay (Left-pinned console) */}
      {isSidebarOpen && (
        <div className="absolute bottom-0 left-0 right-0 top-auto w-full h-[45vh] md:h-auto md:top-3 md:bottom-3 md:left-3 md:right-auto md:w-[320px] md:max-w-[85vw] flex flex-col bg-slate-950/95 backdrop-blur-md border-t md:border border-slate-800/90 rounded-t-2xl md:rounded-2xl p-4 shadow-[0_0_50px_rgba(0,0,0,0.8)] shrink-0 z-40 pointer-events-auto text-left select-none overflow-y-auto custom-scrollbar">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
            <div className="flex items-center space-x-2 text-emerald-400">
              <Sliders className="w-4 h-4 animate-pulse" />
              <h3 className="font-bold text-xs tracking-wide text-slate-100 uppercase">Gaming Controller</h3>
            </div>
            <div className="flex items-center space-x-1">
              <button
                onClick={() => setIsPlaying(!isPlaying)}
                className={`px-2 py-1 rounded-lg font-bold text-[10px] flex items-center space-x-1 shadow-lg border transition-all ${
                  isPlaying 
                    ? 'bg-rose-950/80 hover:bg-rose-900 border-rose-500/50 text-rose-300' 
                    : 'bg-emerald-950/80 hover:bg-emerald-900 border-emerald-500/50 text-emerald-300'
                }`}
                title={isPlaying ? "Stop Input Hook" : "Start Input Hook"}
              >
                {isPlaying ? (
                  <>
                    <Square className="w-3 h-3 fill-current" />
                    <span>PLAYING</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3 fill-current" />
                    <span>START</span>
                  </>
                )}
              </button>
              <button
                onClick={() => setIsSidebarOpen(false)}
                className="p-1 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded-lg transition-colors ml-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Profile Selector */}
          <div className="space-y-1.5 mb-3">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">Controller Profile</label>
            <div className="flex gap-1.5">
              <select
                value={activeProfileIdx}
                onChange={(e) => {
                  setActiveProfileIdx(Number(e.target.value));
                  setSelectedControlId(null);
                }}
                disabled={isPlaying}
                className="flex-1 bg-slate-900/80 text-slate-200 text-xs px-2.5 py-1.5 rounded-lg border border-slate-800 focus:outline-none focus:border-emerald-500/50"
              >
                {profiles.map((p, idx) => (
                  <option key={idx} value={idx}>{p.profileName}</option>
                ))}
              </select>
              <button
                onClick={createNewProfile}
                disabled={isPlaying}
                className="px-2 py-1.5 bg-slate-900/50 hover:bg-slate-800 border border-slate-800 rounded-lg text-slate-300 hover:text-white transition-colors"
                title="Create New Profile"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Action button triggers */}
          <div className="grid grid-cols-2 gap-1.5 mb-3">
            <button
              onClick={() => setIsEditMode(!isEditMode)}
              disabled={isPlaying}
              className={`px-2 py-1.5 rounded-lg border text-[10px] font-semibold flex items-center justify-center space-x-1.5 transition-colors ${
                isEditMode 
                  ? 'bg-amber-950/50 border-amber-500/50 text-amber-400' 
                  : 'bg-slate-900/50 border-slate-850 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Settings className="w-3 h-3" />
              <span>{isEditMode ? "Lock Map" : "Map Keys"}</span>
            </button>
            <button
              onClick={handleExportProfile}
              className="px-2 py-1.5 bg-slate-900/50 hover:bg-slate-800 border border-slate-850 rounded-lg text-[10px] font-semibold text-slate-300 hover:text-white flex items-center justify-center space-x-1.5 transition-colors"
            >
              <Download className="w-3 h-3" />
              <span>Export</span>
            </button>
          </div>

          <div className="mb-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-1 bg-slate-900/30 hover:bg-slate-800 border border-dashed border-slate-800 rounded-lg text-[10px] font-semibold text-slate-400 hover:text-slate-200 flex items-center justify-center space-x-1.5 transition-colors"
            >
              <Upload className="w-3 h-3" />
              <span>Import Mapping JSON</span>
            </button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImportProfile}
              accept=".json"
              className="hidden"
            />
          </div>

          {/* Configured Keys List */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Mapping Keys ({currentProfile.controls.length})</span>
              {isEditMode && (
                <div className="flex items-center space-x-1">
                  <button
                    onClick={() => handleAddControl('TAP')}
                    className="px-1 py-0.5 bg-slate-900/50 hover:bg-slate-800 border border-slate-850 rounded text-[8px] font-bold text-emerald-400 hover:text-emerald-300"
                  >
                    + Tap
                  </button>
                  <button
                    onClick={() => handleAddControl('JOYSTICK')}
                    className="px-1 py-0.5 bg-slate-900/50 hover:bg-slate-800 border border-slate-850 rounded text-[8px] font-bold text-sky-400 hover:text-sky-300"
                  >
                    + Joy
                  </button>
                  <button
                    onClick={() => handleAddControl('SWIPE')}
                    className="px-1 py-0.5 bg-slate-900/50 hover:bg-slate-800 border border-slate-850 rounded text-[8px] font-bold text-purple-400 hover:text-purple-300"
                  >
                    + Swipe
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 max-h-[15vh] md:max-h-[35vh] custom-scrollbar">
              {currentProfile.controls.map((ctrl) => {
                const isSelected = selectedControlId === ctrl.id;
                return (
                  <div
                    key={ctrl.id}
                    onClick={() => isEditMode && setSelectedControlId(ctrl.id)}
                    className={`p-2 rounded-lg border text-left transition-all ${
                      isEditMode ? 'cursor-pointer' : ''
                    } ${
                      isSelected 
                        ? 'bg-slate-900 border-emerald-500/40' 
                        : 'bg-slate-900/40 border-slate-850/80 hover:bg-slate-900/80 hover:border-slate-700/80'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1 mr-1">
                        <span className="text-[11px] font-semibold text-slate-200 block truncate">{ctrl.name}</span>
                        <span className={`text-[8px] font-mono px-1 py-0.2 rounded uppercase mt-0.5 inline-block ${
                          ctrl.type === 'JOYSTICK' ? 'bg-sky-950/50 text-sky-400 border border-sky-900/30' :
                          ctrl.type === 'TAP' ? 'bg-emerald-950/50 text-emerald-400 border border-emerald-900/30' :
                          'bg-purple-950/50 text-purple-400 border border-purple-900/30'
                        }`}>
                          {ctrl.type}
                        </span>
                      </div>

                      <div className="flex items-center space-x-1 shrink-0">
                        <span className="font-mono text-[9px] font-extrabold text-slate-400 bg-slate-950 px-1 py-0.2 rounded border border-slate-800">
                          {ctrl.type === 'JOYSTICK' 
                            ? `${ctrl.keys?.up}/${ctrl.keys?.down}/${ctrl.keys?.left}/${ctrl.keys?.right}`.toUpperCase()
                            : ctrl.key?.toUpperCase() || "?"}
                        </span>
                        {isEditMode && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteControl(ctrl.id);
                            }}
                            className="p-0.5 hover:bg-rose-950/30 text-rose-500 hover:text-rose-400 rounded transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {currentProfile.controls.length === 0 && (
                <div className="text-center py-4 text-slate-500 text-[10px] border border-dashed border-slate-800 rounded-lg">
                  No keys. Click Map Keys and + to begin.
                </div>
              )}
            </div>
          </div>

          {/* Active Key Editing Forms */}
          {isEditMode && selectedControl && (
            <div className="border-t border-slate-800 mt-3 pt-3 space-y-2.5 shrink-0 max-h-[20vh] md:max-h-none overflow-y-auto custom-scrollbar">
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">Editing: {selectedControl.name}</span>
              
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className="text-[8px] text-slate-400 block mb-0.5">Control Label</label>
                  <input
                    type="text"
                    value={selectedControl.name}
                    onChange={(e) => handleUpdateControlValue(selectedControl.id, 'name', e.target.value)}
                    className="w-full bg-slate-900 text-slate-200 text-[10px] px-2 py-1 rounded border border-slate-800 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[8px] text-slate-400 block mb-0.5">Pointer ID</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={selectedControl.pointerId}
                    onChange={(e) => handleUpdateControlValue(selectedControl.id, 'pointerId', Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full bg-slate-900 text-slate-200 text-[10px] px-2 py-1 rounded border border-slate-800 focus:outline-none"
                  />
                </div>
              </div>

              {selectedControl.type === 'JOYSTICK' && (
                <div className="grid grid-cols-2 gap-1.5">
                  <div>
                    <label className="text-[8px] text-slate-400 block mb-0.5">Joy Radius</label>
                    <input
                      type="number"
                      min="30"
                      max="300"
                      value={selectedControl.radius || 80}
                      onChange={(e) => handleUpdateControlValue(selectedControl.id, 'radius', Math.max(30, parseInt(e.target.value) || 80))}
                      className="w-full bg-slate-900 text-slate-200 text-[10px] px-2 py-1 rounded border border-slate-800 focus:outline-none"
                    />
                  </div>
                </div>
              )}

              {selectedControl.type === 'JOYSTICK' && selectedControl.keys && (
                <div className="space-y-1">
                  <label className="text-[8px] text-slate-400 block">Joystick Keys (W, S, A, D)</label>
                  <div className="grid grid-cols-4 gap-1">
                    {(['up', 'down', 'left', 'right'] as const).map((dir) => (
                      <div key={dir} className="flex flex-col items-center">
                        <span className="text-[7px] uppercase text-slate-500 mb-0.5">{dir}</span>
                        <input
                          type="text"
                          maxLength={15}
                          value={selectedControl.keys?.[dir] || ''}
                          onChange={(e) => {
                            const val = e.target.value.toLowerCase();
                            handleUpdateControlValue(selectedControl.id, 'keys', {
                              ...selectedControl.keys,
                              [dir]: val
                            });
                          }}
                          className="w-full bg-slate-900 text-slate-200 text-[9px] font-mono text-center py-1 rounded border border-slate-850 focus:outline-none"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(selectedControl.type === 'TAP' || selectedControl.type === 'SWIPE') && (
                <div>
                  <label className="text-[8px] text-slate-400 block mb-0.5">Trigger Key</label>
                  <input
                    type="text"
                    value={selectedControl.key || ''}
                    placeholder="e.g. j, k, shift, space"
                    onChange={(e) => handleUpdateControlValue(selectedControl.id, 'key', e.target.value.toLowerCase())}
                    className="w-full bg-slate-900 text-slate-200 text-[10px] px-2 py-1 rounded border border-slate-800 focus:outline-none"
                  />
                </div>
              )}

              {selectedControl.type === 'SWIPE' && (
                <div className="space-y-1">
                  <label className="text-[8px] text-slate-400 block">Swipe Vector Delta (X, Y px)</label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <div>
                      <span className="text-[7px] text-slate-500">Delta X</span>
                      <input
                        type="number"
                        value={selectedControl.direction?.x || 0}
                        onChange={(e) => handleUpdateControlValue(selectedControl.id, 'direction', {
                          x: parseInt(e.target.value) || 0,
                          y: selectedControl.direction?.y || -80
                        })}
                        className="w-full bg-slate-900 text-slate-200 text-[10px] px-2 py-1 rounded border border-slate-800 focus:outline-none"
                      />
                    </div>
                    <div>
                      <span className="text-[7px] text-slate-500">Delta Y</span>
                      <input
                        type="number"
                        value={selectedControl.direction?.y || -80}
                        onChange={(e) => handleUpdateControlValue(selectedControl.id, 'direction', {
                          x: selectedControl.direction?.x || 0,
                          y: parseInt(e.target.value) || 0
                        })}
                        className="w-full bg-slate-900 text-slate-200 text-[10px] px-2 py-1 rounded border border-slate-800 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="border-t border-slate-850 mt-auto pt-2 text-[9px] text-slate-500 flex items-start space-x-1 shrink-0">
            <Info className="w-3 h-3 text-slate-400 shrink-0 mt-0.5" />
            <p className="leading-normal">
              <strong>Tip:</strong> Drag controllers around the screen to map. Enable <strong>START</strong> to play with PC keys, or touch buttons on screen to play.
            </p>
          </div>
        </div>
      )}

      {/* Primary Key-Mapping Interactive overlay layer - Rendered precisely over the live phone stream canvas */}
      {canvasLayout && (
        <div 
          onClick={handleOverlayCanvasClick}
          onPointerMove={handleIndicatorPointerMove}
          style={{
            position: 'absolute',
            left: `${canvasLayout.leftOffset}px`,
            top: `${canvasLayout.topOffset}px`,
            width: `${canvasLayout.width}px`,
            height: `${canvasLayout.height}px`,
            touchAction: 'none'
          }}
          className={`z-30 overflow-hidden select-none ${
            isEditMode 
              ? 'cursor-crosshair border border-dashed border-emerald-500/50 bg-slate-950/5 pointer-events-auto' 
              : 'pointer-events-none'
          }`}
        >
          {/* Guide Banner in Edit Mode */}
          {isEditMode && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-slate-950/95 text-amber-400 text-[9px] font-bold px-3 py-1.5 rounded-full shadow-2xl border border-slate-800/80 flex items-center space-x-1.5 z-40">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>
                {selectedControlId 
                  ? `Drag "${selectedControl?.name}" directly to reposition`
                  : "Tap a controller dot on-screen and drag to place it anywhere."}
              </span>
            </div>
          )}

          {/* Render visual controller dots inside canvas coordinates */}
          {currentProfile.controls.map((ctrl) => {
            const relCoords = ctrl.type === 'JOYSTICK' ? ctrl.center :
                             ctrl.type === 'TAP' ? ctrl.position : ctrl.startPosition;
            if (!relCoords) return null;

            const pos = getVisualPosition(relCoords.x, relCoords.y);
            const isSelected = selectedControlId === ctrl.id;

            // Handle touch drag or tap actions based on whether we are playing or editing
            const pointerHandlers = isEditMode 
              ? {
                  onPointerDown: (e: React.PointerEvent) => handleIndicatorPointerDown(e, ctrl.id),
                  onPointerUp: handleIndicatorPointerUp,
                }
              : isPlaying 
                ? ctrl.type === 'JOYSTICK'
                  ? {
                      onPointerDown: (e: React.PointerEvent) => handleVirtualJoyPointerDown(e, ctrl),
                      onPointerMove: (e: React.PointerEvent) => handleVirtualJoyPointerMove(e, ctrl),
                      onPointerUp: (e: React.PointerEvent) => handleVirtualJoyPointerUp(e, ctrl),
                      onPointerCancel: (e: React.PointerEvent) => handleVirtualJoyPointerUp(e, ctrl),
                    }
                  : ctrl.type === 'TAP'
                    ? {
                        onPointerDown: (e: React.PointerEvent) => handleVirtualTapPointerDown(e, ctrl),
                        onPointerUp: (e: React.PointerEvent) => handleVirtualTapPointerUp(e, ctrl),
                        onPointerCancel: (e: React.PointerEvent) => handleVirtualTapPointerUp(e, ctrl),
                      }
                    : {
                        onPointerDown: (e: React.PointerEvent) => handleVirtualSwipePointerDown(e, ctrl),
                      }
                : {};

            const isKnobShifted = joystickOffsets[ctrl.id];

            return (
              <div
                key={ctrl.id}
                style={{ 
                  position: 'absolute', 
                  left: `${pos.x}px`, 
                  top: `${pos.y}px`,
                  transform: 'translate(-50%, -50%)',
                  pointerEvents: (isEditMode || isPlaying) ? 'auto' : 'none',
                  touchAction: 'none'
                }}
                {...pointerHandlers}
                className={`flex items-center justify-center rounded-full transition-all select-none ${
                  ctrl.type === 'JOYSTICK' 
                    ? 'w-20 h-20 bg-sky-500/10 border-2 border-sky-400/90 shadow-[0_0_15px_rgba(56,189,248,0.35)]' 
                    : ctrl.type === 'TAP' 
                      ? 'w-11 h-11 bg-emerald-500/15 border-2 border-emerald-400/90 shadow-[0_0_12px_rgba(52,211,153,0.35)]' 
                      : 'w-11 h-11 bg-purple-500/15 border-2 border-purple-400/90 shadow-[0_0_12px_rgba(192,132,252,0.35)]'
                } ${
                  isEditMode ? 'hover:scale-105 cursor-grab active:cursor-grabbing' : 'cursor-pointer active:scale-95'
                } ${
                  isSelected && isEditMode ? 'ring-4 ring-emerald-400 ring-offset-2 ring-offset-slate-900 border-dashed scale-105 z-30' : ''
                }`}
              >
                {/* Joystick Center Control Knob - fluid animated circle moving according to active touch offsets */}
                {ctrl.type === 'JOYSTICK' && (
                  <div 
                    className="absolute w-8 h-8 rounded-full bg-sky-400/30 border border-sky-300 shadow-md flex items-center justify-center transition-transform duration-75 pointer-events-none"
                    style={{
                      transform: isKnobShifted 
                        ? `translate(${isKnobShifted.x}px, ${isKnobShifted.y}px)` 
                        : 'translate(0, 0)'
                    }}
                  >
                    <div className="w-2.5 h-2.5 rounded-full bg-sky-300" />
                  </div>
                )}

                <div className="flex flex-col items-center justify-center text-center p-1 pointer-events-none">
                  {ctrl.type !== 'JOYSTICK' && (
                    <span className="font-sans font-black text-[10px] text-slate-100 uppercase tracking-wide leading-none truncate max-w-[36px]">
                      {ctrl.key || '?'}
                    </span>
                  )}
                  {ctrl.type === 'JOYSTICK' && !isKnobShifted && (
                    <span className="font-sans font-extrabold text-[8px] text-sky-200 uppercase tracking-wider leading-none">
                      JOYSTICK
                    </span>
                  )}
                  {ctrl.type === 'JOYSTICK' && ctrl.keys && !isKnobShifted && (
                    <span className="font-mono text-[7px] text-sky-300 mt-1 uppercase font-bold tracking-tight">
                      {`${ctrl.keys.up}${ctrl.keys.down}${ctrl.keys.left}${ctrl.keys.right}`}
                    </span>
                  )}
                  {ctrl.type === 'SWIPE' && ctrl.direction && (
                    <span className="text-[7px] text-purple-300 mt-0.5 font-bold leading-none">
                      Swipe {ctrl.direction.y < 0 ? '↑' : ctrl.direction.y > 0 ? '↓' : ''}{ctrl.direction.x > 0 ? '→' : ctrl.direction.x < 0 ? '←' : ''}
                    </span>
                  )}
                </div>

                {/* Draw Joystick Outer Movement Boundaries */}
                {ctrl.type === 'JOYSTICK' && (
                  <div 
                    className="absolute rounded-full border border-sky-500/20 pointer-events-none"
                    style={{
                      width: `${(ctrl.radius || 80) * 2}px`,
                      height: `${(ctrl.radius || 80) * 2}px`,
                      left: '50%',
                      top: '50%',
                      transform: 'translate(-50%, -50%)',
                    }}
                  />
                )}

                {/* Draw Swipe vector arrow */}
                {ctrl.type === 'SWIPE' && ctrl.direction && (
                  <div 
                    className="absolute h-0.5 bg-purple-400/50 origin-left pointer-events-none"
                    style={{
                      width: `${Math.sqrt(ctrl.direction.x * ctrl.direction.x + ctrl.direction.y * ctrl.direction.y)}px`,
                      left: '50%',
                      top: '50%',
                      transform: `rotate(${Math.atan2(ctrl.direction.y, ctrl.direction.x)}rad)`,
                    }}
                  >
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 border-y-3 border-y-transparent border-l-4 border-l-purple-400" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>,
    containerEl
  );
}
