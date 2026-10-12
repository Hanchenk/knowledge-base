import type { BotFrame } from "./vendor/bloub/engine";
import { NOTIF_BLUE } from "./vendor/bloub/decor";
import { mixHex } from "./vendor/bloub/skins";
import { RAYON } from "./vendor/bloub/repere";

const NS = "http://www.w3.org/2000/svg";
function node<K extends keyof SVGElementTagNameMap>(
  tag: K,
  parent: SVGElement,
) {
  const element = document.createElementNS(NS, tag);
  parent.appendChild(element);
  return element;
}
function attr(element: SVGElement, name: string, value: string | number) {
  const text = String(value);
  if (element.getAttribute(name) !== text) element.setAttribute(name, text);
}
function show(element: SVGElement, visible: boolean) {
  attr(element, "display", visible ? "inline" : "none");
}

/** Own only the SVG layer children; React owns the shell and accessibility. */
export function bloubRenderer(
  svg: SVGSVGElement,
  uid: string,
  color: string,
  paper: string,
) {
  const part = (name: string) =>
    svg.querySelector<SVGGElement>(`[data-part="${name}"]`)!;
  const mask = part("mask"),
    defs = part("gradients"),
    body = part("body");
  const back = part("arcs-back"),
    front = part("arcs-front");
  const behind = part("dots-back"),
    ahead = part("dots-front");
  const maskBody = node("path", mask);
  attr(maskBody, "fill", "#fff");
  const eyes = [node("path", mask), node("path", mask)];
  eyes.forEach((eye) => attr(eye, "fill", "#000"));
  const notch = node("circle", mask);
  attr(notch, "fill", "#000");
  const bodyPath = node("path", body);
  attr(bodyPath, "fill", paper);
  const fill = node("path", body);
  attr(fill, "fill", color);
  attr(fill, "mask", `url(#bloub-${uid})`);
  const notif = node("circle", part("notification"));
  attr(notif, "fill", NOTIF_BLUE);
  const arcs: {
    gradient: SVGLinearGradientElement;
    stops: SVGStopElement[];
    back: SVGPathElement;
    front: SVGPathElement;
  }[] = [];
  const dots: {
    root: SVGGElement;
    path: SVGPathElement;
    circle: SVGCircleElement;
  }[] = [];
  const circle = (
    element: SVGCircleElement,
    value: { x: number; y: number; r: number } | null,
  ) => {
    show(element, !!value);
    if (value) {
      attr(element, "cx", value.x);
      attr(element, "cy", value.y);
      attr(element, "r", value.r);
    }
  };
  return {
    paint(frame: BotFrame) {
      attr(maskBody, "d", frame.bodyPath);
      attr(bodyPath, "d", frame.bodyPath);
      attr(fill, "d", frame.bodyPath);
      attr(body, "opacity", frame.bodyAlpha);
      eyes.forEach((element, i) => {
        const eye = frame.eyes[i];
        show(element, !!eye);
        if (eye) {
          attr(element, "d", eye.d);
          attr(element, "transform", eye.matrix);
          attr(element, "opacity", eye.alpha);
        }
      });
      circle(notch, frame.notch);
      circle(notif, frame.notif);
      frame.arcs.forEach((arc, i) => {
        if (!arcs[i]) {
          const gradient = node("linearGradient", defs);
          attr(gradient, "id", `${uid}-arc-${i}`);
          attr(gradient, "gradientUnits", "userSpaceOnUse");
          const paths = [node("path", back), node("path", front)];
          paths.forEach((path) =>
            attr(path, "stroke", `url(#${uid}-arc-${i})`),
          );
          arcs[i] = { gradient, stops: [], back: paths[0], front: paths[1] };
        }
        const slot = arcs[i];
        for (const key of ["x1", "y1", "x2", "y2"] as const)
          attr(slot.gradient, key, arc.grad[key]);
        arc.grad.stops.forEach((color, j) => {
          const stop = (slot.stops[j] ||= node("stop", slot.gradient));
          show(stop, true);
          attr(stop, "offset", j / Math.max(1, arc.grad.stops.length - 1));
          attr(stop, "stop-color", color);
        });
        slot.stops
          .slice(arc.grad.stops.length)
          .forEach((stop) => show(stop, false));
        for (const side of ["front", "back"] as const) {
          const path = slot[side];
          show(path, true);
          attr(path, "d", arc[side]);
          attr(path, "stroke-width", arc.width);
          attr(path, "opacity", arc.opacity);
        }
      });
      arcs.slice(frame.arcs.length).forEach((slot) => {
        show(slot.back, false);
        show(slot.front, false);
      });
      frame.dots.forEach((dot, i) => {
        if (!dots[i]) {
          const root = node("g", ahead);
          dots[i] = {
            root,
            path: node("path", root),
            circle: node("circle", root),
          };
        }
        const slot = dots[i],
          parent = frame.dotsBehind ? behind : ahead;
        if (slot.root.parentNode !== parent) parent.appendChild(slot.root);
        show(slot.root, true);
        show(slot.path, !!dot.d);
        show(slot.circle, !dot.d);
        attr(slot.root, "opacity", dot.opacity);
        attr(
          slot.root,
          "fill",
          dot.color ??
            (dot.depth === undefined ? color : mixHex(paper, color, dot.depth)),
        );
        if (dot.d) {
          attr(slot.path, "d", dot.d);
          attr(
            slot.path,
            "transform",
            `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`,
          );
        } else circle(slot.circle, dot);
      });
      dots.slice(frame.dots.length).forEach((slot) => show(slot.root, false));
    },
    dispose() {
      [
        mask,
        defs,
        body,
        back,
        front,
        behind,
        ahead,
        part("notification"),
      ].forEach((layer) => layer.replaceChildren());
    },
  };
}
