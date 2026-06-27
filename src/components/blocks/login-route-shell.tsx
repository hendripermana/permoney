import { AuthShell } from "@/components/blocks/auth-shell"
import { LoginForm } from "@/components/login-form"

export function LoginRouteShell() {
  return (
    <AuthShell>
      <LoginForm />
    </AuthShell>
  )
}
