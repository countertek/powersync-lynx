package com.lynx.tasm.behavior;

import android.content.Context;
import android.content.ContextWrapper;

public class LynxContext extends ContextWrapper {
  public LynxContext(Context base) {
    super(base);
  }

  public Context getContext() {
    return getBaseContext();
  }
}
