package ink.miller.honghong;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * v1.2 诊断版（2026-11-14）：v1.1 在用户真机上「安装成功但启动即闪退」，且浏览器能开
 * 线上站点（网络无关）、摘除 Firebase 后复现（非 Firebase）。没有 adb 拿不到 logcat，
 * 本版把崩溃原因**显示在屏幕上**：onCreate 全捕获 + 全局未捕获异常落盘，下次启动弹窗
 * 回放。拿到原因后此机制原样保留（线上问题也一样能看到），不再需要用户接电脑。
 */
public class MainActivity extends BridgeActivity {

    /** 崩溃落盘文件（应用私有目录，无需存储权限） */
    private static File crashFile(Context ctx) {
        return new File(ctx.getExternalFilesDir(null), "last_crash.txt");
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 全局兜底：任何线程的未捕获异常先落盘再交给系统（系统照常闪退，但痕迹留下了）
        final Activity act = this;
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try {
                PrintWriter w = new PrintWriter(crashFile(act), "UTF-8");
                w.println("thread=" + t.getName() + " device=" + Build.MANUFACTURER + " " + Build.MODEL
                        + " android=" + Build.VERSION.RELEASE + " sdk=" + Build.VERSION.SDK_INT);
                e.printStackTrace(w);
                w.close();
            } catch (Throwable ignored) {
            }
        });

        try {
            super.onCreate(savedInstanceState);
        } catch (Throwable t) {
            if (isWebViewTooOld(t)) {
                // 系统WebView提供方过旧（如无GMS的老设备：提供方包名与Google不同，
                // 装新版WebView APK也换不掉）——壳在此设备上无法运行，指路浏览器
                showWebViewTooOld(t);
            } else {
                showFatal("onCreate 异常", t);
            }
            return;
        }

        // 走到这说明这次启动成功了——回放上一次的崩溃（如果有的话）
        showLastCrashIfAny();
    }

    private void showFatal(String lead, Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        String text = "设备: " + Build.MANUFACTURER + " " + Build.MODEL
                + "  Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")\n\n"
                + lead + "\n" + sw;
        // 同时落盘：下一次能打开时也能看到
        try {
            PrintWriter w = new PrintWriter(crashFile(this), "UTF-8");
            w.print(text);
            w.close();
        } catch (Throwable ignored) {
        }
        show(text);
    }

    /**
     * WebView 提供方过旧的识别（2026-11-14，多亲 Qin 2 / Android 9 实锤）：
     * AbstractMethodError on WebViewFactoryProvider.getWebViewClassLoader ——
     * androidx.webkit 的 glue 通信要求提供方实现 P 接口，老提供方没有 → 初始化即炸。
     */
    private static boolean isWebViewTooOld(Throwable t) {
        Throwable cur = t;
        while (cur != null) {
            String msg = cur.getMessage();
            if (cur instanceof AbstractMethodError && msg != null && msg.contains("WebViewFactoryProvider")) return true;
            for (StackTraceElement f : cur.getStackTrace()) {
                if (f.getClassName().contains("WebViewGlueCommunicator")) return true;
            }
            cur = cur.getCause();
        }
        return false;
    }

    private void showWebViewTooOld(Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        String detail = "设备: " + Build.MANUFACTURER + " " + Build.MODEL
                + "  Android " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")\n" + sw;
        try {
            new AlertDialog.Builder(this)
                    .setTitle("这台设备的系统 WebView 过旧")
                    .setMessage("本应用需要较新的系统 WebView 才能运行。这台设备的 WebView 版本过旧（且无法通过安装应用更新）。\n\n请用手机浏览器打开 honghong.miller.ink 使用，体验完整一致。")
                    .setPositiveButton("用浏览器打开", (d, w) -> {
                        try {
                            startActivity(new android.content.Intent(
                                    android.content.Intent.ACTION_VIEW,
                                    android.net.Uri.parse("https://honghong.miller.ink")));
                        } catch (Throwable ignored) {
                        }
                    })
                    .setNeutralButton("复制详情", (d, w) -> {
                        try {
                            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                            cm.setPrimaryClip(ClipData.newPlainText("crash", detail));
                            Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show();
                        } catch (Throwable ignored) {
                        }
                    })
                    .show();
        } catch (Throwable ignored) {
        }
    }

    private void showLastCrashIfAny() {
        try {
            File f = crashFile(this);
            if (!f.exists()) return;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new FileReader(f))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line).append('\n');
            }
            if (sb.length() == 0) return;
            // 展示后清掉，避免每次启动都弹
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            show("上一次的崩溃（已清除）:\n\n" + sb);
        } catch (Throwable ignored) {
        }
    }

    private void show(String text) {
        try {
            new AlertDialog.Builder(this)
                    .setTitle("壳诊断信息（复制后发给编码侧）")
                    .setMessage(text.length() > 3800 ? text.substring(0, 3800) + " …" : text)
                    .setPositiveButton("知道了", null)
                    .setNeutralButton("复制", (d, w) -> {
                        try {
                            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                            cm.setPrimaryClip(ClipData.newPlainText("crash", text));
                            Toast.makeText(this, "已复制，去微信/邮件粘贴即可", Toast.LENGTH_SHORT).show();
                        } catch (Throwable ignored) {
                        }
                    })
                    .show();
        } catch (Throwable ignored) {
            // 连弹窗都弹不出就真的没救了——那种情况走无线 adb 取 logcat
        }
    }
}
