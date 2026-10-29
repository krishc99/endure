package dev.krish.rundj.bg;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "RunDJBackground", permissions = {
        @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS}),
        @Permission(alias = "activity", strings = {Manifest.permission.ACTIVITY_RECOGNITION})
})
public class RunDJBackgroundPlugin extends Plugin {

    @Override
    public void load() {
        DJService.listener = o -> {
            try { notifyListeners("state", new JSObject(o.toString())); } catch (Exception ignored) { }
        };
    }

    private boolean notificationAccess() {
        Context c = getContext();
        String flat = Settings.Secure.getString(c.getContentResolver(), "enabled_notification_listeners");
        String me = new ComponentName(c, NotifListener.class).flattenToString();
        return flat != null && flat.contains(me);
    }

    private boolean ytmInstalled() {
        try { getContext().getPackageManager().getPackageInfo(DJService.YTM, 0); return true; }
        catch (PackageManager.NameNotFoundException e) { return false; }
    }

    private JSObject state() {
        JSObject r = new JSObject();
        r.put("notificationAccess", notificationAccess());
        r.put("overlay", Settings.canDrawOverlays(getContext()));
        r.put("youtubeMusic", ytmInstalled());
        r.put("running", DJService.running);
        r.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        r.put("activity", getPermissionState("activity") == PermissionState.GRANTED);
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(state()); }

    @PluginMethod
    public void askPermissions(PluginCall call) {
        boolean need = getPermissionState("activity") != PermissionState.GRANTED
                || (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED);
        if (need) requestAllPermissions(call, "permsDone"); else call.resolve(state());
    }

    @PermissionCallback
    private void permsDone(PluginCall call) { call.resolve(state()); }

    @PluginMethod
    public void openNotificationAccess(PluginCall call) {
        getActivity().startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
        call.resolve();
    }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName())));
        call.resolve();
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        call.resolve();
    }

    /** library: JSON text {songs:[...], settings:{...}} written by the app. */
    @PluginMethod
    public void start(PluginCall call) {
        String lib = call.getString("library");
        if (lib == null) { call.reject("library missing"); return; }
        try {
            new JSONObject(lib);
            File f = new File(getContext().getFilesDir(), "rundj_background.json");
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(lib.getBytes(StandardCharsets.UTF_8)); }
        } catch (Exception e) { call.reject("Could not save the library: " + e.getMessage()); return; }
        Context c = getContext();
        Intent i = new Intent(c, DJService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (Exception e) { call.reject("Android refused to start background mode: " + e.getMessage()); return; }
        call.resolve(state());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context c = getContext();
        c.stopService(new Intent(c, DJService.class));
        call.resolve();
    }

    @PluginMethod
    public void lastState(PluginCall call) {
        JSONObject o = DJService.lastState;
        try { call.resolve(o == null ? new JSObject() : new JSObject(o.toString())); } catch (Exception e) { call.resolve(new JSObject()); }
    }
}
