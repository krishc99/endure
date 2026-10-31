// Bundles Capacitor core + the native plugins + the on-phone analyser into www/bridge.js for the plain-JS page.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Health } from '@capgo/capacitor-health';
import { CapacitorPedometer } from '@capgo/capacitor-pedometer';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import * as Analyzer from './analyzer.js';
const Background = registerPlugin('RunDJBackground');   // plugins/rundj-background (Android)
const AppleMusic = registerPlugin('RunDJAppleMusic');   // plugins/rundj-applemusic (iOS)
window.RunDJNative = { isNative: Capacitor.isNativePlatform(), platform: Capacitor.getPlatform(), Background, AppleMusic, Health, Pedometer: CapacitorPedometer, KeepAwake, Filesystem, Directory, Encoding, Share };
window.RunDJAnalyzer = Analyzer;
