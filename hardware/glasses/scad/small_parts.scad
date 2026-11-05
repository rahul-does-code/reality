// Small parts. Each is a module; export one at a time with -D 'part="..."' (see export.sh):
//   display_carrier  holds the OLED (glass toward the lens, through the window); slides in the box
//   lens_ring        presses into the lens seat behind the lens
//   light_shield     glue over the open front of the lens housing between the lens and the box
//   end_cap          closes the outer end of the display box and pod (USB-C opening)
//   battery_lid      closes the battery pod on the left temple
// All print flat (as oriented here), no supports.
include <params.scad>
use <lib.scad>

part = "display_carrier";

// Display carrier, drawn in print orientation: an L (plate + tongue) extruded along z.
// In the box: the plate stands across the optical axis with the display glass pressed to its outer
// face (tape or a dab of hot glue on the PCB corners), the tongue lies on the floor toward the lens,
// and an M2 screw from under the box floor, through the slot, holds it at focus.
module display_carrier() {
  in_y = 2 * box_hy - 2 * wall - 2 * clear; // across the box
  in_z = 2 * box_hz - 2 * wall - 2 * clear; // box inside height
  tongue = 12;
  difference() {
    union() {
      cube([carrier_t, in_z, in_y]);                 // plate: x = thickness, y = height (z in the box), z = width (y in the box)
      translate([-tongue, 0, in_y / 2 - 6]) cube([tongue + carrier_t, carrier_t, 12]); // tongue
    }
    // window for the visible area (box y -> part z, box z -> part y)
    translate([-1, in_z / 2 + disp_active_dz - (disp_active + 1) / 2, in_y / 2 + disp_active_dy - (disp_active + 1) / 2])
      cube([carrier_t + 2, disp_active + 1, disp_active + 1]);
    // clamp screw (self-taps into the tongue from below)
    translate([-5, -1, in_y / 2]) rotate([-90, 0, 0]) cylinder(d = m2_tap, h = carrier_t + 2);
  }
}

module lens_ring() {
  difference() {
    cylinder(d = lens_d + 0.4 - 0.15, h = 1.5);
    translate([0, 0, -1]) cylinder(d = lens_d - 4, h = 4);
  }
}

module light_shield() {
  w = join_x - wall - (lens_x + lens_plate_t / 2) + 2; // overlaps both by 1 mm
  translate([0, 0, 0]) cube([w, 2 * house_hz, 1.2]);
}

// End cap, in print orientation (outer face down): the box + pod outline, with a locating lip that
// fits inside both. USB-C opening where the XIAO's port lands (pod floor + ~2.4 mm).
module end_cap() {
  lip = 1.6;
  module outline(inset) {
    translate([split_y - box_hy + inset, -box_hz + inset]) square([2 * box_hy - 2 * inset, 2 * box_hz - 2 * inset]);
    translate([split_y - pod_in_y / 2 - wall + inset, box_hz - 0.01 - (inset > 0 ? wall : 0)])
      square([pod_in_y + 2 * wall - 2 * inset, pod_in_z + wall + 0.01 - inset + (inset > 0 ? wall : 0)]);
  }
  difference() {
    union() {
      linear_extrude(1.6) outline(0);
      linear_extrude(1.6 + lip) difference() { outline(wall + clear); offset(r = -1.2) outline(wall + clear); }
    }
    translate([split_y, box_hz + 2.4, 0]) linear_extrude(10, center = true) rounded_square(usb_w, usb_h, 2);
  }
}

module battery_lid() {
  cube([bat_l + 1 + 2 * wall, bat_w + 0.6 + 2 * wall, 1.2]);
}

if (part == "display_carrier") display_carrier();
if (part == "lens_ring") lens_ring();
if (part == "light_shield") light_shield();
if (part == "end_cap") end_cap();
if (part == "battery_lid") battery_lid();
