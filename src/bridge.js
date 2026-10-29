// Bundles Capacitor core + the native plugins + the on-phone analyser into www/bridge.js for the plain-JS page.
import { Capacitor } from '@capacitor/core';
import { Health } from '@capgo/capacitor-health';
import { CapacitorPedometer } from '@capgo/capacitor-pedometer';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import * as Analyzer from './analyzer.js';
window.RunDJNative = { isNative: Capacitor.isNativePlatform(), Health, Pedometer: CapacitorPedometer, KeepAwake, Filesystem, Directory, Encoding };
window.RunDJAnalyzer = Analyzer;
