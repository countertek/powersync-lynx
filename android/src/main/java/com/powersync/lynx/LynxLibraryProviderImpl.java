package com.powersync.lynx;

import androidx.annotation.Keep;
import com.lynx.tasm.library.LynxLibraryProvider;
import com.lynx.tasm.library.LynxLibraryRegistry;

/** Autolink 4.0 looks up {@code <packageName>.LynxLibraryProviderImpl}. */
@Keep
public final class LynxLibraryProviderImpl implements LynxLibraryProvider {
  @Override
  public void register(LynxLibraryRegistry registry) {
    registry.registerModule("NativePowerSyncModule", NativePowerSyncModule.class);
  }
}
