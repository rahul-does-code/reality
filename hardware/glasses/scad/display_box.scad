// Display box + electronics pod. The box bolts to the lens housing's outer flange (4x M2) and holds
// the display carrier, which slides along x to focus and is clamped by one M2 screw through the slot
// in the floor. The pod on top holds the XIAO ESP32S3 Sense (camera looking out of the front window),
// the MPU-6050, and two buttons in its top. The outer end of both is open; end_cap.stl closes it
// (with the USB-C opening).
// Print standing on the flange (the face that touches the lens housing), no supports.
include <params.scad>
use <lib.scad>

bx0 = join_x;
by0 = split_y - box_hy;
by1 = split_y + box_hy;
py0 = split_y - pod_in_y / 2 - wall;
py1 = split_y + pod_in_y / 2 + wall;
pz1 = pod_z0 + pod_in_z + wall;

// carrier clamp slot range: the tongue's screw sits 5 mm on the lens side of the display glass
slot_x0 = disp_x_nominal - focus_travel - 5;
slot_x1 = disp_x_nominal + focus_travel - 5;

module display_box() {
  difference() {
    union() {
      // box shell (open at the outer end)
      difference() {
        translate([bx0, by0, -box_hz]) cube([box_x1 - bx0, by1 - by0, 2 * box_hz]);
        translate([bx0 + wall, by0 + wall, -box_hz + wall]) cube([box_x1 - bx0, by1 - by0 - 2 * wall, 2 * box_hz - 2 * wall]);
      }
      // pod shell on top (open at the outer end; its floor is the box top)
      difference() {
        translate([pod_x0, py0, pod_z0 - 0.01]) cube([pod_x1 - pod_x0, py1 - py0, pz1 - pod_z0]);
        translate([pod_x0 + wall, py0 + wall, pod_z0]) cube([pod_x1 - pod_x0, pod_in_y, pod_in_z]);
      }
    }
    // light from the lens
    translate([bx0 + wall / 2, split_y, 0]) cube([wall + 1, light_hole, light_hole], center = true);
    // screws to the lens housing (clearance; they self-tap into its flange)
    for (j = join_holes) translate([bx0 + wall / 2, j[0], j[1]]) rotate([0, 90, 0]) cylinder(d = m2_hole, h = wall + 1, center = true);
    // wires from the lens housing
    translate([bx0 + wall / 2, house_y0 + wall + 2.5, house_hz - wall - 2]) rotate([0, 90, 0]) cylinder(d = 3.5, h = wall + 1, center = true);
    // wires from the box into the pod (display, battery)
    for (x = [pod_x0 + wall + 3, box_x1 - 6]) translate([x, split_y - pod_in_y / 2 + 4, box_hz - wall / 2]) cube([4, 6, wall + 1], center = true);
    // carrier clamp slot in the floor
    hull() for (x = [slot_x0, slot_x1]) translate([x, split_y, -box_hz + wall / 2]) cylinder(d = m2_hole, h = wall + 1, center = true);
    // camera window in the pod front
    translate([cam_x, py1 - wall / 2, pod_z0 + pod_in_z / 2]) cube([cam_win, wall + 1, cam_win], center = true);
    // button holes in the pod top: Select (toward the eye) and Undo/Done
    for (x = [pod_x0 + wall + 8, pod_x0 + wall + 20]) translate([x, split_y, pz1 - wall / 2]) cylinder(d = button_d, h = wall + 1, center = true);
  }
}

print = false; // export.sh sets true: flange (the lens housing side) down on the bed
if (print) translate([0, 0, -join_x]) rotate([0, -90, 0]) display_box(); else display_box();
