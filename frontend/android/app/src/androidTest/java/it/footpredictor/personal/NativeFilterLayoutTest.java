package it.footpredictor.personal;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.view.ContextThemeWrapper;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.CheckedTextView;
import android.widget.FrameLayout;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativeFilterLayoutTest {
    @Test
    public void filterRowsStayCompactAfterLaunchThemeTransition() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
            ContextThemeWrapper context = new ContextThemeWrapper(app, R.style.AppTheme_NoActionBarLaunch);
            context.getTheme(); // Resolve launch resources before the activity changes its theme.
            // Match BridgeActivity: applying the runtime theme merges attributes
            // into the launch theme rather than clearing unspecified view styles.
            context.setTheme(R.style.AppTheme_NoActionBar);
            float density = context.getResources().getDisplayMetrics().density;
            for (String label : new String[] { "Tutti gli esiti", "Vinte", "Perse", "Annullate" }) {
                CheckedTextView row = (CheckedTextView) LayoutInflater.from(context)
                    .inflate(android.R.layout.select_dialog_singlechoice, new FrameLayout(context), false);
                row.setText(label);
                row.measure(View.MeasureSpec.makeMeasureSpec((int) (320 * density), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
                assertTrue(label + " should retain a visible touch target", row.getMeasuredHeight() >= 40 * density);
                assertTrue(label + " must not inherit the splash image height", row.getMeasuredHeight() <= 96 * density);
            }
        });
    }
}
