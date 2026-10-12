import logo from "./assets/product-logo.png";

export function ProductLogo({
  className = "",
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <img
      className={`product-logo ${className}`}
      src={logo}
      alt={decorative ? "" : "知汇产品 Logo"}
      draggable={false}
    />
  );
}
