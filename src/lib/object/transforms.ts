// Affine matrices [a,b,c,d,e,f] in PDF user space, to pass to FPDFPageObj_Transform (which
// pre-multiplies the object's current matrix). Y is up in PDF space.

export type Matrix6 = [number, number, number, number, number, number];

/** Translate by (dx, dy) PDF points. */
export const moveMatrix = (dx: number, dy: number): Matrix6 => [1, 0, 0, 1, dx, dy];

/** Scale by (fx, fy) about the fixed point (ax, ay) so that point stays put. */
export const scaleAboutMatrix = (fx: number, fy: number, ax: number, ay: number): Matrix6 => [
  fx,
  0,
  0,
  fy,
  ax * (1 - fx),
  ay * (1 - fy),
];

/** Rotate by `theta` radians about the point (cx, cy). */
export const rotateAboutMatrix = (theta: number, cx: number, cy: number): Matrix6 => {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
};
