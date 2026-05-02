import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldError,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useServerFn } from "@tanstack/react-start"
import { useMutation } from "@tanstack/react-query"
import { signupFn } from "@/server/auth.server"
import { useRouter } from "@tanstack/react-router"

export function SignUpForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const router = useRouter()
  const signup = useServerFn(signupFn)

  const mutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const fullname = formData.get("fullname") as string
      const username = formData.get("username") as string
      const email = formData.get("email") as string
      const password = formData.get("password") as string
      return signup({ data: { fullname, username, email, password } })
    },
    onSuccess: () => {
      void router.invalidate()
    },
  })

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="overflow-hidden border-none p-0 shadow-lg">
        <CardContent className="grid min-h-[500px] p-0 md:grid-cols-2">
          <form
            className="flex flex-col justify-center p-6 md:p-8"
            onSubmit={(e) => {
              e.preventDefault()
              mutation.mutate(new FormData(e.currentTarget))
            }}
          >
            <FieldGroup>
              <div className="mb-4 flex flex-col items-center gap-2 text-center">
                <h1 className="text-3xl font-bold">Join Permoney 🐝</h1>
                <p className="text-balance text-muted-foreground">
                  Create an account to start tracking your expenses.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="fullname">Full Name</FieldLabel>
                  <Input
                    id="fullname"
                    name="fullname"
                    type="text"
                    autoComplete="name"
                    placeholder="John Doe"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="username">Username</FieldLabel>
                  <Input
                    id="username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    placeholder="johndoe"
                    required
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="name@example.com"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </Field>
              {mutation.error && (
                <FieldError className="text-red-500">
                  {mutation.error.message}
                </FieldError>
              )}
              <Field className="mt-4">
                <Button
                  type="submit"
                  disabled={mutation.isPending}
                  className="w-full bg-yellow-500 font-semibold text-black hover:bg-yellow-600"
                >
                  {mutation.isPending
                    ? "Creating Account..."
                    : "Create Account"}
                </Button>
              </Field>
              <FieldDescription className="mt-4 text-center">
                Already have an account?{" "}
                <a href="/login" className="font-medium underline">
                  Login here
                </a>
              </FieldDescription>
            </FieldGroup>
          </form>
          <div className="relative hidden flex-col items-center justify-center overflow-hidden bg-zinc-900 p-10 text-white md:flex">
            <div className="absolute inset-0 z-0 bg-gradient-to-br from-yellow-500/20 to-zinc-900/90" />
            <div className="relative z-10 space-y-4 text-center">
              <div className="mb-6 text-6xl">🐝</div>
              <h2 className="text-2xl font-bold">
                Your Financial Journey Starts Here.
              </h2>
              <p className="text-sm text-zinc-400">
                Set up your custom categories, invite family members, and take
                control of your wealth.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
