// Small helpers shared by the parts.

module rounded_square(w, h, r) {
  r2 = min(r, w / 2 - 0.01, h / 2 - 0.01);
  offset(r = r2) square([w - 2 * r2, h - 2 * r2], center = true);
}

// A plate in the x-z plane between y = y0 and y = y0 + t, from a 2D shape drawn in (x, z).
module xz_plate(y0, t) {
  translate([0, y0 + t, 0]) rotate([90, 0, 0]) linear_extrude(t) children();
}

// A plate in the y-z plane between x = x0 and x = x0 + t, from a 2D shape drawn in (y, z).
module yz_plate(x0, t) {
  translate([x0, 0, 0]) rotate([90, 0, 90]) linear_extrude(t) children();
}

// A round hole along x whose top is pointed (45 degrees, cut flat 1 mm above the circle) toward
// +dir so it prints without supports when that axis points up: dir = "y" or "z".
module teardrop_x(d, len, dir = "y") {
  rotate([0, 90, 0]) linear_extrude(len, center = true)
    rotate([0, 0, dir == "y" ? 90 : 0])  // 2D +x below ends up along +dir
      intersection() {
        union() {
          circle(d = d);
          rotate([0, 0, -45]) square(d / 2); // the point, toward 2D +x
        }
        translate([-d, -d]) square([2 * d, 2 * d]);
        translate([-d, -d]) square([d / 2 + 1 + d, 2 * d]);
      }
}
