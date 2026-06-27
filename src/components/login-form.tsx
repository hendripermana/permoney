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
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { loginFn } from "@/server/auth-fns"
import { Link, useRouter } from "@tanstack/react-router"

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const login = useServerFn(loginFn)

  const mutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const email = formData.get("email") as string
      const password = formData.get("password") as string
      return login({ data: { email, password } })
    },
    onSuccess: async (result) => {
      await Promise.all([queryClient.invalidateQueries(), router.invalidate()])
      await router.navigate({ to: result.redirectTo })
    },
  })

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="overflow-hidden border-none p-0 shadow-lg">
        <CardContent className="grid min-h-[500px] p-0 md:grid-cols-2">
          {/* BAGIAN KIRI: FORM LOGIN */}
          <form
            method="post"
            className="flex flex-col justify-center p-6 md:p-8"
            onSubmit={(e) => {
              e.preventDefault()
              mutation.mutate(new FormData(e.currentTarget))
            }}
          >
            <FieldGroup>
              <div className="mb-4 flex flex-col items-center gap-2 text-center">
                <h1 className="text-3xl font-semibold">
                  Welcome to Permoney 🐝
                </h1>
                <p className="text-balance text-muted-foreground">
                  Manage your family finances without the headache.
                </p>
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
                  autoComplete="current-password"
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
                  variant="wise"
                  disabled={mutation.isPending}
                  className="w-full font-semibold"
                >
                  {mutation.isPending ? "Logging in..." : "Login"}
                </Button>
              </Field>
              <FieldDescription className="mt-4 text-center">
                Don&apos;t have an account?{" "}
                <Link to="/signup" className="font-medium underline">
                  Sign up here
                </Link>
              </FieldDescription>
            </FieldGroup>
          </form>

          {/* BAGIAN KANAN: BACKGROUND */}
          <div className="relative hidden flex-col items-center justify-center overflow-hidden bg-wise-dark-green p-10 text-white md:flex">
            <div className="absolute inset-0 z-0 bg-gradient-to-br from-wise-green/25 to-wise-dark-green/90" />
            <div className="relative z-10 space-y-4 text-center">
              <div className="mb-6 text-6xl">🍯</div>
              <h2 className="text-2xl font-semibold">Track. Monitor. Relax.</h2>
              <p className="text-sm text-wise-pastel/80">
                Track your daily expenses, cat supplies, and family dining out
                in one unified place.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
