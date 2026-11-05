// Temples. The front end screws onto the frame's joint block (2x M2 from the outside). The left one
// carries the battery pod on its outer side (open on the outside; battery_lid.stl closes it), with
// the power switch in its front wall and the wires leaving toward the frame.
// Print lying on the inner face (as oriented here: x up = away from the head), no supports.
// side = "left" or "right" (export.sh sets it).
include <params.scad>
use <lib.scad>

side = "left";

// Temple profile in (y, z), y = 0 at the frame's back face.
module profile() {
  end = [-temple_len - temple_drop_len * cos(temple_drop_deg), temple_z - temple_drop_len * sin(temple_drop_deg)];
  union() {
    hull() {
      translate([-0.5, temple_z]) square([1, temple_h], center = true);
      translate([-temple_len, temple_z]) circle(d = 7);
    }
    hull() {
      translate([-temple_len, temple_z]) circle(d = 7);
      translate(end) circle(d = 6);
    }
  }
}

pod_l = bat_l + 1 + 2 * wall;
pod_w = bat_w + 0.6 + 2 * wall; // along z
pod_t = bat_t + 0.6;            // inside depth (outward)

// Built for the right side in wearer coordinates with the outer face at x = temple_t;
// mirrored for the left. Placed so the inner face is at x = 0 (print bed).
module temple(left) {
  difference() {
    union() {
      yz_plate(0, temple_t) profile();
      if (left) translate([temple_t - 0.01, bat_y0 - pod_l, temple_z - pod_w / 2]) cube([pod_t + 0.01, pod_l, pod_w]);
    }
    // joint screws (clearance; they self-tap into the frame's joint block)
    for (y = joint_holes_y) translate([temple_t / 2, y, temple_z]) rotate([0, 90, 0]) cylinder(d = m2_hole, h = temple_t + 1, center = true);
    if (left) {
      // battery cavity (open toward +x)
      translate([temple_t - 1, bat_y0 - pod_l + wall, temple_z - pod_w / 2 + wall]) cube([pod_t + 2, pod_l - 2 * wall, pod_w - 2 * wall]);
      // power switch in the front wall
      translate([temple_t + pod_t / 2 + 0.5, bat_y0 - wall / 2, temple_z + 3]) cube([switch_w, wall + 1, switch_l], center = true);
      // wires out toward the frame
      translate([temple_t + 1.8, bat_y0 - wall / 2, temple_z - pod_w / 2 + wall + 2]) rotate([90, 0, 0]) cylinder(d = 3, h = wall + 1, center = true);
    }
  }
}

print = false; // export.sh sets true: inner face down on the bed
if (print) rotate([0, -90, 0]) temple(side == "left"); else temple(side == "left");
