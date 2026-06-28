export interface TelemetryState {
  battery: {
    level: number;       // % (0-100)
    temperature: number; // °C (e.g. 35.2)
    voltage: number;     // V (e.g. 4.15)
  };
  cpu: {
    cores: number[];     // Frequencies of each core in MHz
    averageFreq: number; // Average core frequency in MHz
  };
  ram: {
    total: number;       // MB
    available: number;   // MB
    used: number;        // MB
    percentage: number;  // % (0-100)
  };
  network: {
    rxBytes: number;     // Total received bytes
    txBytes: number;     // Total transmitted bytes
    downloadSpeed: number; // KB/s
    uploadSpeed: number;   // KB/s
  };
  gpu: {
    load: number;        // % (0-100)
  };
}

export const INITIAL_TELEMETRY_STATE: TelemetryState = {
  battery: { level: 0, temperature: 0, voltage: 0 },
  cpu: { cores: [], averageFreq: 0 },
  ram: { total: 0, available: 0, used: 0, percentage: 0 },
  network: { rxBytes: 0, txBytes: 0, downloadSpeed: 0, uploadSpeed: 0 },
  gpu: { load: 0 }
};

/**
 * Parses raw text output from the optimized combined ADB telemetry shell command.
 * 
 * Command output structure expected:
 * ---BATTERY---
 * level: 85
 * temperature: 350
 * voltage: 4125
 * ---CPU_FREQ---
 * 1400000
 * 1800000
 * ...
 * ---MEM---
 * MemTotal:        5789124 kB
 * MemAvailable:    2103492 kB
 * ---NET---
 *  wlan0: 1618302194  2719280 ...
 * ---GPU---
 * 15
 */
export function parseTelemetry(
  rawOutput: string,
  prevState?: TelemetryState,
  lastTimestamp?: number
): { data: TelemetryState; timestamp: number } {
  const now = Date.now();
  const sections: { [key: string]: string } = {};
  
  // Split raw output into sections using ---DELIMITER--- lines
  let currentSection = '';
  const lines = rawOutput.split(/\r?\n/);
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('---') && trimmed.endsWith('---')) {
      currentSection = trimmed.replace(/---/g, '').toUpperCase();
      sections[currentSection] = '';
    } else if (currentSection) {
      sections[currentSection] += line + '\n';
    }
  }

  // Initialize fresh telemetry data
  const data: TelemetryState = JSON.parse(JSON.stringify(INITIAL_TELEMETRY_STATE));

  // 1. Parse Battery
  if (sections['BATTERY']) {
    const batteryText = sections['BATTERY'];
    const levelMatch = batteryText.match(/level:\s*(\d+)/i);
    const tempMatch = batteryText.match(/temperature:\s*(\d+)/i);
    const voltMatch = batteryText.match(/voltage:\s*(\d+)/i);

    if (levelMatch) {
      data.battery.level = parseInt(levelMatch[1], 10);
    }
    if (tempMatch) {
      const rawTemp = parseInt(tempMatch[1], 10);
      // Android battery temperatures are usually in tenths of a degree Celsius (e.g. 352 -> 35.2°C)
      data.battery.temperature = rawTemp > 100 ? rawTemp / 10 : rawTemp;
    }
    if (voltMatch) {
      const rawVolt = parseInt(voltMatch[1], 10);
      // Android battery voltage is usually in mV (e.g. 4125 -> 4.125V)
      data.battery.voltage = rawVolt > 1000 ? rawVolt / 1000 : rawVolt;
    }
  }

  // 2. Parse CPU Frequencies (cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq)
  if (sections['CPU_FREQ']) {
    const cpuText = sections['CPU_FREQ'].trim();
    const freqMatches = cpuText.split(/\s+/).filter(Boolean);
    const cores: number[] = [];
    
    for (const freqStr of freqMatches) {
      const freqKHz = parseInt(freqStr, 10);
      if (!isNaN(freqKHz) && freqKHz > 0) {
        // Convert kHz to MHz
        cores.push(Math.round(freqKHz / 1000));
      }
    }
    
    data.cpu.cores = cores;
    if (cores.length > 0) {
      const sum = cores.reduce((acc, val) => acc + val, 0);
      data.cpu.averageFreq = Math.round(sum / cores.length);
    }
  }

  // 3. Parse Memory (cat /proc/meminfo)
  if (sections['MEM']) {
    const memText = sections['MEM'];
    const totalMatch = memText.match(/MemTotal:\s*(\d+)/i);
    const availMatch = memText.match(/MemAvailable:\s*(\d+)/i);

    if (totalMatch) {
      const totalKB = parseInt(totalMatch[1], 10);
      data.ram.total = Math.round(totalKB / 1024); // Convert to MB
    }
    if (availMatch) {
      const availKB = parseInt(availMatch[1], 10);
      data.ram.available = Math.round(availKB / 1024); // Convert to MB
    }

    if (data.ram.total > 0) {
      data.ram.used = Math.max(0, data.ram.total - data.ram.available);
      data.ram.percentage = Math.round((data.ram.used / data.ram.total) * 100);
    }
  }

  // 4. Parse Network (cat /proc/net/dev | grep 'wlan0')
  if (sections['NET']) {
    const netText = sections['NET'];
    const wlanMatch = netText.match(/wlan0:\s*(.*)/i);
    if (wlanMatch) {
      const parts = wlanMatch[1].trim().split(/\s+/);
      if (parts.length >= 9) {
        data.network.rxBytes = parseInt(parts[0], 10) || 0;
        data.network.txBytes = parseInt(parts[8], 10) || 0;
      }
    }
  }

  // Calculate speeds if we have previous state
  if (prevState && lastTimestamp && lastTimestamp < now) {
    const timeDeltaSec = (now - lastTimestamp) / 1000;
    
    if (timeDeltaSec > 0.1) {
      // Delta bytes
      const rxDelta = data.network.rxBytes - prevState.network.rxBytes;
      const txDelta = data.network.txBytes - prevState.network.txBytes;

      // Handle raw counters wrap-around or reset
      if (rxDelta >= 0 && prevState.network.rxBytes > 0) {
        data.network.downloadSpeed = Math.round((rxDelta / 1024) / timeDeltaSec * 10) / 10; // KB/s
      }
      if (txDelta >= 0 && prevState.network.txBytes > 0) {
        data.network.uploadSpeed = Math.round((txDelta / 1024) / timeDeltaSec * 10) / 10; // KB/s
      }
    }
  }

  // 5. Parse GPU Load
  if (sections['GPU']) {
    const gpuText = sections['GPU'].trim();
    const gpuNum = parseInt(gpuText, 10);
    if (!isNaN(gpuNum) && gpuNum >= 0 && gpuNum <= 100) {
      data.gpu.load = gpuNum;
    }
  }

  return { data, timestamp: now };
}
