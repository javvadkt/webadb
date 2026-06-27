import { Adb, AdbCredentialStore, AdbPrivateKey, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbWebUsbBackend, AdbWebUsbBackendManager } from '@yume-chan/adb-backend-webusb';
import { AdbScrcpyClient, AdbScrcpyOptions2_1 } from '@yume-chan/adb-scrcpy';
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
    onStateChange: (state: ConnectionState) => void
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
        // Try to fetch from local public folder
        const response = await fetch('/scrcpy-server.jar');
        if (!response.ok) {
          throw new Error(`Failed to fetch local server: ${response.status}`);
        }
        serverBytes = new Uint8Array(await response.arrayBuffer());
      } catch (err) {
        console.warn("Could not load local /scrcpy-server.jar, falling back to public CDN...", err);
        // Fallback to official JsDelivr CDN hosting Genymobile scrcpy-server v2.1
        const fallbackUrl = 'https://cdn.jsdelivr.net/gh/Genymobile/scrcpy@v2.1/server/scrcpy-server';
        const response = await fetch(fallbackUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch scrcpy-server from fallback CDN: ${response.status}`);
        }
        serverBytes = new Uint8Array(await response.arrayBuffer());
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

      // Instantiate options for scrcpy (compatible with v2.1)
      const options = new AdbScrcpyOptions2_1({
        logLevel: "debug",
        videoCodec: "h264",
        videoBitRate: 4000000, // 4 Mbps
        audio: false,
      });

      this.scrcpyClient = await AdbScrcpyClient.start(
        this.adb,
        '/data/local/tmp/scrcpy-server.jar',
        options
      );

      onStateChange({ status: 'active', deviceName: backend.name });
      return this.scrcpyClient;

    } catch (error: any) {
      console.error("Connection failed:", error);
      onStateChange({
        status: 'disconnected',
        error: error?.message || String(error),
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
      this.backend = null;
    } catch (e) {
      console.error("Error during disconnect:", e);
    }
  }
}
