package com.lynx.jsbridge;

import android.content.Context;

public abstract class LynxModule {
  protected Context mContext;
  protected Object mParam;
  protected Object mExtraData;

  public LynxModule(Context context) {
    this(context, null);
  }

  public LynxModule(Context context, Object param) {
    mContext = context;
    mParam = param;
  }

  public void setExtraData(Object data) {
    mExtraData = data;
  }

  public void destroy() {}
}
