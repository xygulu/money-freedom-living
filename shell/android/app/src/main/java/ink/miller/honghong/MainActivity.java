package ink.miller.honghong;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;

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
            showFatal("onCreate 异常", t);
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
                    .setTitle("壳诊断信息（截图发给编码侧）")
                    .setMessage(text.length() > 3800 ? text.substring(0, 3800) + " …" : text)
                    .setPositiveButton("知道了", null)
                    .show();
        } catch (Throwable ignored) {
            // 连弹窗都弹不出就真的没救了——那种情况走无线 adb 取 logcat
        }
    }
}
