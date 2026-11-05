// Shared dimensions for the DIY "Reality is yours" glasses. Everything is in mm.
// Wearer coordinates: x = to the wearer's right (+), y = forward toward the world (+), z = up (+).
// The frame front sits between y = 0 (back face, toward the eyes) and y = frame_t; the eyes are
// ~14 mm behind y = 0; the right eye's axis is the line x = ipd/2, z = 0.
//
// Measure your own parts and change these before printing. The ones you should check are marked
// MEASURE; the rest are design choices.

$fn = 64;
clear = 0.3;          // fit clearance for parts that slide into each other (tune for your printer)
m2_hole = 2.2;        // through hole for an M2 screw
m2_tap = 1.7;         // hole an M2 screw self-taps into (plastic)

// ---- face ----
ipd = 63;             // MEASURE: your pupil distance (a ruler in a mirror, or an optician's number)
frame_half_w = 71;    // half the frame width; the temples sit at +-frame_half_w (MEASURE: head width / 2 at the temples, minus 2)
frame_t = 5;          // frame thickness (front to back)

// ---- rims (open; no lenses) ----
rim_w = 40;           // opening width
rim_h = 32;           // opening height
rim_cx = ipd / 2 + 4; // rim center (x): a little outboard of the pupil, as in ordinary glasses
rim_bar = 4.5;        // rim border width
rim_r = 8;            // opening corner radius
rim_outer_w = rim_w + 2 * rim_bar;
rim_outer_h = rim_h + 2 * rim_bar;
bridge_gap = 2 * rim_cx - rim_outer_w;  // space between the rims at the nose (the bridge spans it)
nose_top_w = 16;      // nose notch width at its top (z = nose_top_z)
nose_top_z = 2;
nose_bot_w = 26;      // and at the bottom edge of the frame

// ---- nose pads (printed on the back of the frame) ----
pad_depth = 9;        // how far the pads reach back toward the face
pad_z = -12;          // pad height relative to the eye line

// ---- temples ----
temple_t = 4;         // thickness (x)
temple_h = 10;        // height (z) at the front
temple_z = 8;         // temple centerline height (z)
temple_len = 112;     // straight part, from the frame back face to the ear (MEASURE: frame to the top of your ear)
temple_drop_len = 34; // part that bends down behind the ear
temple_drop_deg = 32;
joint_len = 14;       // how far the frame's joint block reaches back
joint_w = 5;          // joint block width (x)
joint_holes_y = [-4.5, -10.5]; // M2 screw positions along the joint (y)

// ---- wire channel (battery on the left temple -> electronics on the right) ----
wire_w = 2.6;
wire_d = 2;

// ---- optics: OLED -> lens -> 45 degree beam splitter -> right eye ----
// The display faces the nose (-x) on the outer side of the right eye; the splitter in front of the
// eye reflects it back toward the eye (-y) while the world shows through it. One reflection mirrors
// the picture left-right: the firmware flips it (MIRROR_X in config.h).
lens_d = 25;              // MEASURE: lens diameter (Google Cardboard lenses are 25 mm, f ~45 mm)
split_y = frame_t + 2 + lens_d / 2 + 1.5; // optical axis (y): splitter center, lens center, display center
split_w = 25.4;           // MEASURE: beam splitter plate width (the 45 degree side)
split_h = 25.4;           // MEASURE: plate height
split_t = 1.1;            // MEASURE: plate thickness
lens_f = 45;              // MEASURE: lens focal length
lens_edge = 3.5;          // MEASURE: lens edge thickness
lens_gap = 14;            // splitter center -> lens center (x)
// Display -> lens distance: a bit under the focal length puts the picture ~1 m away. The display
// carrier slides +-6 mm around this for focusing.
disp_dist = lens_f * 1000 / (lens_f + 1000);
disp_pcb_w = 44.5;        // MEASURE: display module PCB width (horizontal, along y)
disp_pcb_h = 37.0;        // MEASURE: display module PCB height (z)
disp_pcb_t = 1.6;
disp_active = 27.0;       // MEASURE: visible area (square, 1.5" 128x128 SSD1351)
disp_active_dy = 0;       // MEASURE: visible area center offset from the PCB center (y)
disp_active_dz = 0;       // MEASURE: visible area center offset from the PCB center (z)
disp_parts_t = 5;         // MEASURE: tallest part on the back of the display PCB (pin header etc.)

// ---- lens housing (in front of the right eye; screws to the frame front) ----
wall = 2;
house_x0 = ipd / 2 - split_w / (2 * sqrt(2)) - 2.5 - wall; // nose-side wall
lens_x = ipd / 2 + lens_gap;                     // lens center (x)
house_y0 = frame_t;                              // sits on the frame front
house_y1 = split_y + max(split_w / (2 * sqrt(2)) + 3, lens_d / 2 + 3.4); // front edge
house_hz = rim_outer_h / 2;                      // half height (z), same as the rims
join_x = frame_half_w + 2;                       // where the lens housing meets the display box
lens_plate_t = lens_edge + 3;                    // lens plate thickness (x): 1.5 mm lip + lens + 1.5 mm ring
light_hole = 28;                                 // square light opening between housing and display box
// Frame screw positions (x, z) for the lens housing, clear of the light path (|z| > 14 there).
housing_holes = [[frame_half_w - 2.5, 15.5], [frame_half_w - 5, -18], [lens_x, -rim_outer_h / 2 + rim_bar / 2]];
wire_exit_x = frame_half_w - 8;                  // where the wires pass through the frame to the front

// ---- display box (outboard of the frame; the display slides in it to focus) ----
disp_x_nominal = lens_x + disp_dist;  // display glass (x) at nominal focus
focus_travel = 6;                     // +- range of the display carrier
carrier_t = 2.5;
box_x1 = disp_x_nominal + focus_travel + carrier_t + disp_parts_t + 3;
box_hy = disp_pcb_w / 2 + 0.6 + wall; // half depth (y), centered on the optical axis y = split_y
box_hz = disp_pcb_h / 2 + 0.6 + wall; // half height (z)
join_holes = [[house_y0 + 3, house_hz - 3], [house_y1 - 3, house_hz - 3], [house_y0 + 3, -house_hz + 3], [house_y1 - 3, -house_hz + 3]]; // (y, z)

// ---- electronics pod (on top of the display box): XIAO ESP32S3 Sense + MPU-6050 + 2 buttons ----
pod_in_x = 30;       // inside length (x): XIAO stack is 21 x 17.8
pod_in_y = 25;       // inside depth (y)
pod_in_z = 17;       // MEASURE: XIAO ESP32S3 Sense stacked height incl. the camera flex fold (~15)
pod_x1 = box_x1;     // flush with the display box's outer end (open there; the end cap closes both)
pod_x0 = pod_x1 - pod_in_x - wall;
pod_z0 = box_hz;     // sits on the display box
cam_win = 9;         // camera window (the OV2640 module is ~8.5 mm square)
cam_x = pod_x0 + wall + 8; // camera window center (x): the pod end nearest the eye
button_d = 3.6;      // hole for a 6x6 mm tactile button's plunger
usb_w = 10; usb_h = 5; // USB-C opening in the end cap (MEASURE where your XIAO's port lands)

// ---- battery pod (left temple, outer side) ----
bat_l = 31;          // MEASURE: LiPo length incl. protection board (502030 = 30 mm)
bat_w = 21;          // MEASURE: LiPo width (502030 = 20 mm)
bat_t = 5.5;         // MEASURE: LiPo thickness (502030 = 5 mm)
bat_y0 = -22;        // where the pod starts along the temple (y)
switch_l = 8.8;      // slide switch body (SS12D00 = 8.6 x 3.6)
switch_w = 3.8;
