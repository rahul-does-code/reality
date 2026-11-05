#!/usr/bin/env bash
# Builds every printable part into stl/ and the preview images into images/.
# Needs OpenSCAD (2021.01+); the images also need a display (on a headless machine: xvfb-run).
# Change scad/params.scad (the MEASURE lines) first, then run: ./export.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p stl images
scad() { openscad --export-format binstl -D print=true "$@" 2>&1 | grep -E "WARNING|ERROR" || true; }
scad -o stl/frame_front.stl scad/frame_front.scad
scad -o stl/lens_housing.stl scad/lens_housing.scad
scad -o stl/display_box.stl scad/display_box.scad
scad -D 'side="left"' -o stl/temple_left.stl scad/temple.scad
scad -D 'side="right"' -o stl/temple_right.stl scad/temple.scad
for p in display_carrier lens_ring light_shield end_cap battery_lid; do
  scad -D "part=\"$p\"" -o "stl/$p.stl" scad/small_parts.scad
done
run=""; command -v xvfb-run >/dev/null && [ -z "${DISPLAY:-}" ] && run="xvfb-run -a"
for v in "iso:10,-20,5,60,0,225,420" "front:0,0,0,90,0,0,420" "top:20,0,0,0,0,0,420"; do
  $run openscad -o "images/assembly_${v%%:*}.png" --imgsize=1200,780 --camera="${v#*:}" --colorscheme=Tomorrow scad/assembly.scad 2>&1 | grep -E "WARNING|ERROR" || true
done
ls -la stl
