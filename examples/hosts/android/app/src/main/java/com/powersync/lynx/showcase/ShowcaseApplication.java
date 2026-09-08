package com.powersync.lynx.showcase;

import android.app.Application;
import com.facebook.drawee.backends.pipeline.Fresco;
import com.facebook.imagepipeline.core.ImagePipelineConfig;
import com.facebook.imagepipeline.memory.PoolConfig;
import com.facebook.imagepipeline.memory.PoolFactory;
import com.lynx.service.http.LynxHttpService;
import com.lynx.service.image.LynxImageService;
import com.lynx.service.log.LynxLogService;
import com.lynx.tasm.LynxEnv;
import com.powersync.lynx.NativePowerSyncModule;
import com.lynx.tasm.library.LynxAutolinkGenerated;
import com.lynx.tasm.service.LynxServiceCenter;

public class ShowcaseApplication extends Application {
  @Override
  public void onCreate() {
    super.onCreate();
    PoolFactory factory = new PoolFactory(PoolConfig.newBuilder().build());
    ImagePipelineConfig config =
        ImagePipelineConfig.newBuilder(getApplicationContext()).setPoolFactory(factory).build();
    Fresco.initialize(getApplicationContext(), config);
    LynxServiceCenter.inst().registerService(LynxImageService.getInstance());
    LynxServiceCenter.inst().registerService(LynxLogService.INSTANCE);
    LynxServiceCenter.inst().registerService(LynxHttpService.INSTANCE);
    // Autolink registers NativePowerSyncModule during LynxEnv init.
    LynxEnv.inst().init(this, null, null, null);
    LynxEnv.inst().registerModule("NativePowerSyncModule", NativePowerSyncModule.class);
    LynxEnv.inst().enableLayoutOnly(false);
    LynxEnv.inst().setCreateViewAsync(false);
    LynxAutolinkGenerated.setupGlobal(this);
    LynxEnv.inst().nativeSetLocalEnv("enable_fetch_api_standard_streaming", "true");
  }
}
