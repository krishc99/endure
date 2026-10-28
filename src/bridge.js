// Bundles Capacitor core + the native plugins into www/bridge.js and exposes them to the plain-JS page.
import { Capacitor } from '@capacitor/core';
import { Health } from '@capgo/capacitor-health';
import { CapacitorPedometer } from '@capgo/capacitor-pedometer';
import { KeepAwake } from '@capacitor-community/keep-awake';
window.RunDJNative = { isNative: Capacitor.isNativePlatform(), Health, Pedometer: CapacitorPedometer, KeepAwake };
