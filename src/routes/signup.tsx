import { createFileRoute } from "@tanstack/react-router"
import { SignUpForm } from "@/components/signup-form"

export const Route = createFileRoute("/signup")({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-zinc-100 p-6 md:p-10">
      <div className="w-full max-w-sm md:max-w-4xl">
        <SignUpForm />
      </div>
    </div>
  )
}
