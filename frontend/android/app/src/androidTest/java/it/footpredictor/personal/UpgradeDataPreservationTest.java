package it.footpredictor.personal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Run seedData on the old APK, then verifyData on the replacement without reseeding. */
@RunWith(AndroidJUnit4.class)
public class UpgradeDataPreservationTest {
    private static final String PREFERENCES = "qa_upgrade_preservation";
    private static final String DATABASE = "qa_upgrade_preservation.db";
    private static final String WEB_ORIGIN = "https://localhost/";
    private static final String API_URL = "https://scommese-sportive-backend.hostless.app/api";
    private static final long TIMEOUT_SECONDS = 30;

    @Test
    public void seedData() throws Exception {
        Context context = targetContext();
        String marker = marker();
        assertFalse("Do not reseed an existing baseline", context.getSharedPreferences(PREFERENCES, 0).contains(marker));
        assertFalse("Do not overwrite a baseline file", markerFile(context, marker).exists());
        assertTrue(context.getSharedPreferences(PREFERENCES, 0).edit().putString(marker, marker).commit());
        try (FileOutputStream output = new FileOutputStream(markerFile(context, marker))) {
            output.write(marker.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        try (SQLiteDatabase database = context.openOrCreateDatabase(DATABASE, 0, null)) {
            database.execSQL("CREATE TABLE IF NOT EXISTS markers (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
            database.execSQL("INSERT INTO markers(name, value) VALUES (?, ?)", new Object[] { marker, marker });
        }
        assertEquals("null", evaluate(WEB_ORIGIN, "localStorage.getItem(" + JSONObject.quote(marker) + ")"));
        assertEquals(JSONObject.quote(marker), evaluate(WEB_ORIGIN,
            "(function(){localStorage.setItem(" + JSONObject.quote(marker) + "," + JSONObject.quote(marker)
                + ");return localStorage.getItem(" + JSONObject.quote(marker) + ");})()"));
        setCookie(marker, false);
        verifyData();
        // Allow Chromium's asynchronous localStorage backend to persist before the external process kill.
        Thread.sleep(2000);
    }

    @Test
    public void verifyData() throws Exception {
        Context context = targetContext();
        String marker = marker();
        assertEquals(marker, context.getSharedPreferences(PREFERENCES, 0).getString(marker, null));
        byte[] expected = marker.getBytes(StandardCharsets.UTF_8);
        byte[] actual = new byte[expected.length];
        try (FileInputStream input = new FileInputStream(markerFile(context, marker))) {
            int count = 0;
            int read;
            while (count < actual.length && (read = input.read(actual, count, actual.length - count)) != -1) count += read;
            assertEquals(expected.length, count);
            assertEquals("No extra file content", -1, input.read());
        }
        assertEquals(marker, new String(actual, StandardCharsets.UTF_8));
        try (SQLiteDatabase database = SQLiteDatabase.openDatabase(
                context.getDatabasePath(DATABASE).getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
             Cursor cursor = database.rawQuery("SELECT value FROM markers WHERE name = ?", new String[] { marker })) {
            assertTrue("SQLite baseline must exist", cursor.moveToFirst());
            assertEquals(marker, cursor.getString(0));
            assertFalse("SQLite marker must be unique", cursor.moveToNext());
        }
        assertEquals(JSONObject.quote(marker), evaluate(WEB_ORIGIN, "localStorage.getItem(" + JSONObject.quote(marker) + ")"));
        AtomicReference<String> cookies = new AtomicReference<>();
        onMain(() -> cookies.set(CookieManager.getInstance().getCookie(API_URL)));
        assertNotNull("Persistent API cookie must exist", cookies.get());
        assertTrue("Persistent API cookie must retain its value", hasCookie(cookies.get(), cookieName(marker), marker));
        assertEquals("HttpOnly cookie must not be visible to JavaScript", "false", evaluate(API_URL,
            "document.cookie.split(';').some(function(item){return item.trim().startsWith("
                + JSONObject.quote(cookieName(marker) + "=") + ");})"));
    }

    @Test
    public void cleanupData() throws Exception {
        Context context = targetContext();
        String marker = marker();
        assertTrue(context.getSharedPreferences(PREFERENCES, 0).edit().remove(marker).commit());
        File file = markerFile(context, marker);
        assertTrue("Remove only this QA file", !file.exists() || file.delete());
        if (context.getDatabasePath(DATABASE).exists()) {
            try (SQLiteDatabase database = context.openOrCreateDatabase(DATABASE, 0, null)) {
                database.delete("markers", "name = ?", new String[] { marker });
            }
        }
        assertEquals("null", evaluate(WEB_ORIGIN,
            "(function(){localStorage.removeItem(" + JSONObject.quote(marker) + ");return localStorage.getItem("
                + JSONObject.quote(marker) + ");})()"));
        setCookie(marker, true);
    }

    private static Context targetContext() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("it.footpredictor.personal", context.getPackageName());
        return context;
    }

    private static String marker() {
        String value = InstrumentationRegistry.getArguments().getString("qaMarker");
        assertNotNull("Pass -e qaMarker qa_upgrade_<unique suffix> in every phase", value);
        assertTrue("Use a QA-only marker", value.matches("qa_upgrade_[A-Za-z0-9_]{8,80}"));
        return value;
    }

    private static File markerFile(Context context, String marker) {
        return new File(context.getFilesDir(), marker + ".txt");
    }

    private static String cookieName(String marker) {
        return "qa_preservation_" + marker;
    }

    private static boolean hasCookie(String cookies, String name, String value) {
        for (String cookie : cookies.split(";")) {
            if (cookie.trim().equals(name + "=" + value)) return true;
        }
        return false;
    }

    private static void setCookie(String marker, boolean remove) throws Exception {
        CountDownLatch finished = new CountDownLatch(1);
        AtomicReference<Boolean> accepted = new AtomicReference<>();
        onMain(() -> {
            CookieManager manager = CookieManager.getInstance();
            manager.setAcceptCookie(true);
            manager.setCookie(API_URL, cookieName(marker) + "=" + (remove ? "" : marker)
                + "; Max-Age=" + (remove ? "0" : "86400") + "; Path=/api; Secure; HttpOnly; SameSite=None", result -> {
                    accepted.set(result);
                    manager.flush();
                    finished.countDown();
                });
        });
        assertTrue("Cookie callback timed out", finished.await(TIMEOUT_SECONDS, TimeUnit.SECONDS));
        assertEquals("Cookie write must succeed", Boolean.TRUE, accepted.get());
    }

    private static String evaluate(String origin, String script) throws Exception {
        CountDownLatch finished = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        AtomicReference<Throwable> error = new AtomicReference<>();
        AtomicReference<WebView> view = new AtomicReference<>();
        try {
            onMain(() -> {
                WebView webView = new WebView(targetContext());
                view.set(webView);
                webView.getSettings().setJavaScriptEnabled(true);
                webView.getSettings().setDomStorageEnabled(true);
                webView.getSettings().setBlockNetworkLoads(true);
                webView.setWebViewClient(new WebViewClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView unused, WebResourceRequest request) {
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }

                    @Override
                    public void onPageFinished(WebView loaded, String url) {
                        String expectedOrigin = origin.equals(WEB_ORIGIN) ? "https://localhost" : "https://scommese-sportive-backend.hostless.app";
                        loaded.evaluateJavascript("(function(){if(location.origin!==" + JSONObject.quote(expectedOrigin)
                            + "){throw new Error('Unexpected origin: '+location.origin);}return (" + script + ");})()", value -> {
                                result.set(value);
                                finished.countDown();
                            });
                    }
                });
                try {
                    webView.loadDataWithBaseURL(origin, "<!doctype html><html><body>QA storage probe</body></html>", "text/html", "UTF-8", null);
                } catch (Throwable failure) {
                    error.set(failure);
                    finished.countDown();
                }
            });
            assertTrue("WebView JavaScript callback timed out", finished.await(TIMEOUT_SECONDS, TimeUnit.SECONDS));
            if (error.get() != null) throw new AssertionError("WebView storage probe failed", error.get());
            assertNotNull("Missing JavaScript result", result.get());
            return result.get();
        } finally {
            if (view.get() != null) onMain(() -> view.get().destroy());
        }
    }

    private static void onMain(Runnable action) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(action);
    }
}
