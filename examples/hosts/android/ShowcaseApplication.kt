package com.powersync.lynx.showcase

import android.app.Application
import com.lynx.service.http.LynxHttpService
import com.lynx.tasm.LynxEnv
import com.lynx.tasm.service.LynxServiceCenter

class ShowcaseApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    LynxServiceCenter.inst().registerService(LynxHttpService)
    LynxEnv.inst().init(this, null, null, null)
  }
}
