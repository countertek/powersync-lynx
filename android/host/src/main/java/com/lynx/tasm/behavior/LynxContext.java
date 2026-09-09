package com.lynx.tasm.behavior;

import android.content.Context;
import android.content.ContextWrapper;
import com.lynx.react.bridge.JavaOnlyArray;

public class LynxContext extends ContextWrapper {
  public LynxContext(Context base) {
    super(base);
  }

  public Context getContext() {
    return getBaseContext();
  }

  /** Real Lynx posts to GlobalEventEmitter; stub is a no-op for host unit tests. */
  public void sendGlobalEvent(String name, JavaOnlyArray params) {}
}
