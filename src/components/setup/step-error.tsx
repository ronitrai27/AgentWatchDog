export function StepError({ message }: { message: string | null }) {
  return (
    <div className="reveal" data-open={message !== null} aria-live="polite">
      <div>
        <p className="pt-2 text-[13px] text-[#9a352c]">{message}</p>
      </div>
    </div>
  );
}
