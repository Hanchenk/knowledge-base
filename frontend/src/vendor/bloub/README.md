Vendored from https://github.com/jeremy-prt/bloub
Commit: b4bb3c1b5f93c7b87a2e8d620f667c4093d97749
License: MIT, Copyright (c) 2026 Jérémy Perret.

Only the framework-independent SVG engine is included. BloubAvatar.tsx adapts the original Vue SVG renderer to React. Source geometry is unchanged. eyefit.ts builds its optional custom-shape table lazily to avoid computing unused shapes on module load.
