import { textOn } from "@/lib/format";
import { cn } from "@/lib/utils";

export function TagPill({
  name,
  color,
  active = true,
  onClick,
  className,
  size = "sm",
}: {
  name: string;
  color: string;
  active?: boolean;
  onClick?: () => void;
  className?: string;
  size?: "xs" | "sm";
}) {
  const style = active
    ? { backgroundColor: color, color: textOn(color), borderColor: color }
    : { borderColor: color, color };
  const Comp = onClick ? "button" : "span";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      style={style}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border font-medium leading-none",
        size === "xs" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        onClick && "cursor-pointer transition-opacity hover:opacity-80",
        className,
      )}
    >
      {name}
    </Comp>
  );
}
