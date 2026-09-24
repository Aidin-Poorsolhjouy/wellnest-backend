/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-misused-promises */
import axios from 'axios';
import * as readline from 'readline';

// --- CONFIGURATION ---
const API_URL_POD = 'http://localhost:3000/telemetry/pod';
const API_URL_WEARABLE = 'http://localhost:3000/telemetry/wearable';

// REPLACE THESE WITH REAL UUIDs FROM YOUR DATABASE
const POD_ID = 'c52c304f-eba5-4a19-aa7b-6407f9b878eb'; //POD-1001
const WEARABLE_ID = 'ca636051-19ba-4591-95e0-2a15db6631d3'; //WEAR-2001

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

console.log(`
=========================================
🪹 WELLNEST UNIFIED SIMULATOR 🪹
=========================================
POD CONTROLS:
[ t ] - Trigger High Temp Alert (38°C)
[ n ] - Send Normal Pod Reading (22°C)

WEARABLE CONTROLS:
[ f ] - 🚨 Trigger FALL DETECTED
[ p ] - 🆘 Trigger PANIC BUTTON
[ w ] - Send Normal Walking Movement

[ q ] - Quit Simulator
=========================================
`);

const sendPod = async (temp: number, isAlert = false) => {
  try {
    await axios.post(API_URL_POD, { 
      deviceId: POD_ID, 
      temperature: temp, 
      humidity: 45, 
      gasResistance: 50000, // Replaced co2 with gasResistance
      occupancy: true       // Added occupancy
    });
    console.log(`📡 POD: Temp ${temp}°C ${isAlert ? '🚨' : '✅'}`);
  } catch (e) { console.error('❌ Pod Error'); }
};

const sendWearable = async (event: string) => {
  try {
    await axios.post(API_URL_WEARABLE, {
      deviceId: WEARABLE_ID,
      eventType: event,
    });
    console.log(`⌚ WEARABLE: Sent [${event}]`);
  } catch (e) {
    console.error('❌ Wearable Error');
  }
};

// Background Loop (Normal Pod Data every 15s)
setInterval(() => sendPod(+(21.5 + Math.random()).toFixed(1)), 15000);

// Keyboard Controls
process.stdin.on('keypress', (str, key) => {
  if (key.name === 'q' || (key.ctrl && key.name === 'c')) process.exit();

  // Pod
  if (key.name === 't') sendPod(38.5, true);
  if (key.name === 'n') sendPod(22.0);

  // Wearable
  if (key.name === 'f') sendWearable('FALL');
  if (key.name === 'p') sendWearable('PANIC');
  if (key.name === 'w') sendWearable('REGULAR_MOVEMENT');
});
