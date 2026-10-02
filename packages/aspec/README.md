# Vendored ASPEC Dev Modules

These packages were copied from `D:/ASPEC Dev Modules/modules` on 2026-10-02 so ASPECTenant is self-contained.

They remain independently versioned MIT libraries. ASPECTenant adapts them through application wiring, not by rewriting the module cores unless a concrete incompatibility appears.

See `docs/architecture.md` for which modules are in use and which catalogue modules were left out.

Do not treat this directory as a live link to `D:/ASPEC Dev Modules`. Changes here stay in ASPECTenant.

A shim at `packages/tsconfig.base.json` keeps each module's `extends: ../../tsconfig.base.json` working after the path changed from `modules/<name>` to `packages/aspec/<name>`.
