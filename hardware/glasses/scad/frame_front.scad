// Frame front: two open rims, bridge with a nose notch, end pieces; on the back, nose pads and the
// two joint blocks the temples screw onto (2x M2 each), a wire channel across the top, and three M2
// holes for the optics housing on the right.
// Print face-down (front face on the bed): the pads and joint blocks then grow straight up, no supports.
include <params.scad>
use <lib.scad>

module frame_outline() {
  difference() {
    union() {
      for (s = [-1, 1]) translate([s * rim_cx, 0]) rounded_square(rim_outer_w, rim_outer_h, rim_r + rim_bar);
      // bridge: the top part between the rims
      translate([0, rim_outer_h / 2 - 5]) square([bridge_gap + 2 * rim_bar, 10], center = true);
      // end pieces, out to the temples (full rim height: the lens housing screws on here)
      for (s = [-1, 1])
        translate([s * (rim_cx + rim_outer_w / 2 + (frame_half_w - rim_cx - rim_outer_w / 2) / 2 - 2), 0])
          rounded_square(frame_half_w - rim_cx - rim_outer_w / 2 + 4, rim_outer_h, 3);
    }
    for (s = [-1, 1]) translate([s * rim_cx, 0]) rounded_square(rim_w, rim_h, rim_r);
    // nose notch
    polygon([[-nose_top_w / 2, nose_top_z], [nose_top_w / 2, nose_top_z],
             [nose_bot_w / 2, -rim_outer_h / 2 - 1], [-nose_bot_w / 2, -rim_outer_h / 2 - 1]]);
  }
}

wire_z = rim_outer_h / 2 - rim_bar / 2 - 0.2;

module frame_front() {
  difference() {
    union() {
      xz_plate(0, frame_t) frame_outline();
      // nose pads: from the notch edges back toward the face, angled to rest on the sides of the nose
      for (s = [-1, 1])
        hull() {
          translate([s * (nose_top_w / 2 + 3), -0.5, pad_z]) cube([3, 1, 12], center = true);
          translate([s * (nose_top_w / 2 + 1.5), -pad_depth, pad_z - 1]) rotate([90, 0, 0]) cylinder(d = 7, h = 1, center = true);
        }
      // temple joint blocks (the temple's front end screws onto their outer face)
      for (s = [-1, 1])
        translate([s * (frame_half_w - temple_t - joint_w / 2), -joint_len / 2, temple_z])
          cube([joint_w, joint_len + 0.01, temple_h], center = true);
    }
    // temple screw holes (x direction, self-tapping into the blocks)
    for (s = [-1, 1], y = joint_holes_y)
      translate([s * (frame_half_w - temple_t - joint_w / 2), y, temple_z]) rotate([0, 90, 0]) cylinder(d = m2_tap, h = joint_w + 1, center = true);
    // wire channel along the back of the top bar, from the left end to the right pass-through
    translate([(wire_exit_x - frame_half_w - 1) / 2, wire_d / 2 - 0.01, wire_z]) cube([wire_exit_x + frame_half_w + 1, wire_d + 0.02, wire_w], center = true);
    // wire pass-through to the front, into the lens housing
    translate([wire_exit_x, frame_t / 2, wire_z]) rotate([90, 0, 0]) cylinder(d = 3, h = frame_t + 1, center = true);
    // lens housing screws (from the back, into the housing)
    for (h = housing_holes) translate([h[0], frame_t / 2, h[1]]) rotate([90, 0, 0]) cylinder(d = m2_hole, h = frame_t + 1, center = true);
  }
}

print = false; // export.sh sets true: front face down on the bed
if (print) translate([0, 0, frame_t]) rotate([-90, 0, 0]) frame_front(); else frame_front();
