// Everything in place as worn (preview only; don't print this). Purchased parts are translucent
// stand-ins: display (green), lens (cyan), beam splitter (white), XIAO (red), battery (yellow).
include <params.scad>
use <lib.scad>
use <frame_front.scad>
use <lens_housing.scad>
use <display_box.scad>
use <temple.scad>
use <small_parts.scad>

color("SteelBlue") frame_front();
color("LightSteelBlue") lens_housing();
color("SlateGray") display_box();
color("DarkSlateBlue") translate([frame_half_w - temple_t, 0, 0]) temple(false);
color("DarkSlateBlue") mirror([1, 0, 0]) translate([frame_half_w - temple_t, 0, 0]) temple(true);
in_y = 2 * box_hy - 2 * wall - 2 * clear;
in_z = 2 * box_hz - 2 * wall - 2 * clear;
color("Orange") translate([disp_x_nominal - carrier_t, split_y - in_y / 2, -in_z / 2])
  multmatrix([[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0]]) display_carrier();

// stand-ins
%translate([disp_x_nominal, split_y - disp_pcb_w / 2, -disp_pcb_h / 2]) color("green") cube([disp_pcb_t + 3, disp_pcb_w, disp_pcb_h]);
%translate([lens_x, split_y, 0]) rotate([0, 90, 0]) color("cyan") cylinder(d = lens_d, h = lens_edge, center = true);
%translate([ipd / 2, split_y, 0]) rotate([0, 0, 45]) color("white") cube([split_w, split_t, split_h], center = true);
%translate([pod_x1 - 22, split_y - 9, pod_z0]) color("red") cube([21, 17.8, 14]);
%translate([-frame_half_w - bat_t - 0.6, -22 - bat_l - 0.5 - wall, temple_z - bat_w / 2]) color("yellow") cube([bat_t, bat_l, bat_w]);
// eyes
%for (s = [-1, 1]) translate([s * ipd / 2, -14, 0]) sphere(d = 24);
