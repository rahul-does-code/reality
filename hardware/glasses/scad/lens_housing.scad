// Lens housing: holds the 45 degree beam splitter in front of the right eye and the lens beside it,
// and screws onto the frame front (3x M2 from behind). The display box bolts onto its outer end.
//   - Splitter: drop it in through the diagonal slot in the top; it rests in the groove in the bottom
//     rib. A drop of glue (or a strip of tape over the slot) keeps it there.
//   - Lens: from the outer (display) side into its seat, then press in lens_ring.stl behind it.
// Print standing on its back face (the face that touches the frame), no supports: every wall rises
// straight up, the splitter ribs climb at 45 degrees, and round holes have pointed (teardrop) tops.
include <params.scad>
use <lib.scad>

sx = ipd / 2;        // splitter center x
sd = split_w / (2 * sqrt(2)); // splitter half extent along x and y
rib_z = split_h / 2 - 1.5;    // ribs start here (|z|); the splitter's edges sit 1.5 mm into them
dy = house_y1 - house_y0;

// A strip along the splitter line (45 degrees in x-y) through (sx, split_y), `w` wide, `len` long.
module splitter_strip(len, w, z0, z1) {
  translate([sx, split_y, z0]) rotate([0, 0, 45]) translate([0, 0, 0]) linear_extrude(z1 - z0)
    square([len, w], center = true);
}

module lens_housing() {
  difference() {
    union() {
      // back wall (on the frame), with a window for the eye
      difference() {
        translate([house_x0, house_y0, -house_hz]) cube([join_x - house_x0, wall, 2 * house_hz]);
        translate([house_x0 + wall, house_y0 - 1, -house_hz + wall]) cube([lens_x - lens_plate_t / 2 - house_x0 - wall, wall + 2, house_hz - wall + rib_z - 2]);
      }
      // top and bottom
      for (z = [house_hz - wall, -house_hz]) translate([house_x0, house_y0, z]) cube([join_x - house_x0, dy, wall]);
      // nose-side wall
      translate([house_x0, house_y0, -house_hz]) cube([wall, dy, 2 * house_hz]);
      // splitter ribs, top and bottom
      for (z = [[rib_z, house_hz - 0.01], [-house_hz + 0.01, -rib_z]]) intersection() {
        splitter_strip(split_w + 20, split_t + 4.4, z[0], z[1]);
        translate([house_x0, house_y0, -house_hz]) cube([lens_x - house_x0, dy, 2 * house_hz]);
      }
      // lens plate
      translate([lens_x - lens_plate_t / 2, house_y0, -house_hz]) cube([lens_plate_t, dy, 2 * house_hz]);
      // flange at the outer end, for the display box
      translate([join_x - wall, house_y0, -house_hz]) cube([wall, dy, 2 * house_hz]);
      // screw bosses for the frame screws that land in open space
      for (h = housing_holes) if (h[0] > lens_x + lens_plate_t / 2)
        translate([h[0], house_y0, h[1]]) rotate([-90, 0, 0]) cylinder(d = 5.5, h = 7);
    }
    // splitter: groove in the bottom rib, slot through the top rib and top
    splitter_strip(split_w + 0.6, split_t + clear, -split_h / 2, -rib_z + 0.01);
    splitter_strip(split_w + 0.6, split_t + clear, rib_z - 0.01, house_hz + 1);
    // lens: clear aperture through the plate, seat + ring pocket from the display side
    translate([lens_x, split_y, 0]) teardrop_x(lens_d - 3, lens_plate_t + 1, "y");
    translate([lens_x + lens_plate_t / 2 - (lens_plate_t - 1.5) / 2 + 0.01, split_y, 0]) teardrop_x(lens_d + 0.4, lens_plate_t - 1.5, "y");
    // light opening into the display box
    translate([join_x - wall / 2, split_y, 0]) cube([wall + 1, light_hole, light_hole], center = true);
    // display box screws (self-tap into the flange)
    for (j = join_holes) translate([join_x - wall / 2, j[0], j[1]]) rotate([0, 90, 0]) cylinder(d = m2_tap, h = wall + 1, center = true);
    // frame screws (self-tap from behind)
    for (h = housing_holes) translate([h[0], house_y0 - 1, h[1]]) rotate([-90, 0, 0]) cylinder(d = m2_tap, h = 8);
    // wires: from the frame pass-through, along the top, into the display box
    translate([wire_exit_x, house_y0 + wall / 2, rim_outer_h / 2 - rim_bar / 2 - 0.2]) rotate([90, 0, 0]) cylinder(d = 3.2, h = wall + 1, center = true);
    translate([join_x - wall / 2, house_y0 + wall + 2.5, house_hz - wall - 2]) rotate([0, 90, 0]) cylinder(d = 3.5, h = wall + 1, center = true);
  }
}

print = false; // export.sh sets true: back face (the frame side) down on the bed
if (print) translate([0, 0, -house_y0]) rotate([90, 0, 0]) lens_housing(); else lens_housing();
