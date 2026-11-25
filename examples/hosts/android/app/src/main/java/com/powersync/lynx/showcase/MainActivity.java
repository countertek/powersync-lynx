package com.powersync.lynx.showcase;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import com.lynx.tasm.LynxError;
import com.lynx.tasm.LynxLoadMeta;
import com.lynx.tasm.LynxView;
import com.lynx.tasm.LynxViewBuilder;
import com.lynx.tasm.LynxViewClient;
import com.lynx.tasm.TemplateData;
import com.lynx.tasm.ThreadStrategyForRendering;
import com.lynx.tasm.library.LynxAutolinkGenerated;
import com.powersync.lynx.NativePowerSyncModule;
import com.lynx.xelement.XElementBehaviors;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    LynxView lynxView = buildLynxView();
    lynxView.addLynxViewClient(
        new LynxViewClient() {
          @Override
          public void onReceivedError(LynxError error) {
            Log.e("PSLynx", String.valueOf(error));
          }

          @Override
          public void onLoadSuccess() {
            Log.i("PSLynx", "onLoadSuccess children=" + lynxView.getChildCount()
                + " size=" + lynxView.getWidth() + "x" + lynxView.getHeight());
          }

          @Override
          public void onFirstScreen() {
            Log.i("PSLynx", "onFirstScreen children=" + lynxView.getChildCount()
                + " size=" + lynxView.getWidth() + "x" + lynxView.getHeight());
          }
        });
    Window window = getWindow();
    int canvasColor = Color.parseColor("#050910");

    FrameLayout container = new FrameLayout(this);
    container.setBackgroundColor(canvasColor);
    container.addView(
        lynxView,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    container.setOnApplyWindowInsetsListener(
        (View view, WindowInsets insets) -> {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.graphics.Insets bars =
                insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
          } else {
            view.setPadding(
                insets.getSystemWindowInsetLeft(),
                insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(),
                insets.getSystemWindowInsetBottom());
          }
          return insets;
        });
    setContentView(container);
    window.setStatusBarColor(canvasColor);
    window.setNavigationBarColor(canvasColor);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && window.getInsetsController() != null) {
      window.getInsetsController().setSystemBarsAppearance(
          0,
          android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
              | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
    }
    Map<String, String> pageConfig = new HashMap<>();
    pageConfig.put("enableFetchAPIStandardStreaming", "true");
    LynxLoadMeta.Builder meta = new LynxLoadMeta.Builder();
    meta.setUrl("main.lynx.bundle");
    meta.setLynxViewConfig(pageConfig);
    meta.setGlobalProps(TemplateData.fromMap(HostConfig.globalProps(this)));
    lynxView.loadTemplate(meta.build());
  }

  private LynxView buildLynxView() {
    LynxViewBuilder viewBuilder = new LynxViewBuilder();
    viewBuilder.addBehaviors(new XElementBehaviors().create());
    viewBuilder.setTemplateProvider(new DemoTemplateProvider(this));
    viewBuilder.setThreadStrategyForRendering(ThreadStrategyForRendering.ALL_ON_UI);
    viewBuilder.setEnableLayoutOnly(false);
    viewBuilder.setEnableCreateViewAsync(false);
    LynxAutolinkGenerated.setup(viewBuilder);
    viewBuilder.registerModule("NativePowerSyncModule", NativePowerSyncModule.class);
    return viewBuilder.build(this);
  }
}
