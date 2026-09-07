# Lynx PowerSync Client

Ubiquitous language for the Lynx PowerSync Client spec. Implementation, version pins, and vendor package names do not belong here except as the thing being named.

## Product

**Client**:
The Lynx PowerSync SDK this spec describes. App code imports it. One package, one JavaScript surface.
_Avoid_: bridge (as the product), wrapper, plugin, native SDK (as the product)

**PowerSyncDatabase**:
The Client class app code constructs. Same name as official React Native and Web. Its public TypeScript type is official `CommonPowerSyncDatabase`.
_Avoid_: Adapter, Native Module, AbstractPowerSyncDatabase

**Adapter**:
The platform implementation of PowerSync’s `DBAdapter`: native SQLite plus the PowerSync SQLite core on iOS, Android, Windows, and macOS; the official Web SDK behind the Host helper on Lynx-for-Web.
_Avoid_: native SDK, bridge (when meaning this)

**Native Module**:
The Lynx host hook the Adapter uses on the background thread. Passable values, not a live SQLite handle. Not the public API.
_Avoid_: JS facade, Client, NativeModules as app code

**Host helper**:
JavaScript that runs in the Lynx-for-Web host page and maps Native Module SQL RPC onto official WASQLite. Not a second PowerSyncDatabase.
_Avoid_: Web SDK (the official package), Lynx bundle, WebPowerSyncDatabase

**attach**:
The Host-page function that wires Native Module SQL RPC onto WASQLite for one `<lynx-view>`.
_Avoid_: init, register, bootstrap, Autolink (that is native registration)

**Connector**:
App-supplied object whose official type is `PowerSyncBackendConnector`: `fetchCredentials` and `uploadData`. Lives in app JavaScript. There is no class named `Connector`.
_Avoid_: backend, PowerSync Service, session token (the PowerSync JWT is what `fetchCredentials` returns), a class named Connector

**Schema**:
Client-side SQLite views declared in app code (`Schema`, `Table`, `column`) and applied at open. Not a migration, not the Postgres schema.
_Avoid_: Postgres schema, migration
