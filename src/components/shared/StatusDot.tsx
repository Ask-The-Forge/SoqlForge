/**
 * StatusDot — small colored dot for an org's connectedStatus.
 * Connected → green, RefreshTokenError → red, Unknown/other → yellow.
 */

export function StatusDot({ status }: { status: string }) {
  const color =
    status === "Connected"
      ? "bg-emerald-500"
      : status === "RefreshTokenError"
        ? "bg-red-500"
        : "bg-amber-500";
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${color}`}
      title={status}
      aria-label={`status: ${status}`}
    />
  );
}
