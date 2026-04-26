import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="overflow-hidden border-none p-0 shadow-lg">
        <CardContent className="grid min-h-[500px] p-0 md:grid-cols-2">
          {/* BAGIAN KIRI: FORM LOGIN */}
          <form className="flex flex-col justify-center p-6 md:p-8">
            <FieldGroup>
              <div className="mb-4 flex flex-col items-center gap-2 text-center">
                <h1 className="text-3xl font-bold">Welcome to Permoney 🐝</h1>
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
                <div className="flex items-center">
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <a
                    href="#"
                    className="ml-auto text-sm text-primary underline-offset-2 hover:underline"
                  >
                    Forgot your password?
                  </a>
                </div>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Field className="mt-4">
                <Button
                  type="submit"
                  className="w-full bg-yellow-500 font-semibold text-black hover:bg-yellow-600"
                >
                  Login
                </Button>
              </Field>
              <FieldSeparator className="my-4 *:data-[slot=field-separator-content]:bg-card">
                Or continue with
              </FieldSeparator>
              <Field>
                <Button variant="outline" type="button" className="w-full">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    className="mr-2 h-4 w-4"
                  >
                    <path
                      d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                      fill="currentColor"
                    />
                  </svg>
                  Google
                </Button>
              </Field>
              <FieldDescription className="mt-4 text-center">
                Don&apos;t have an account?{" "}
                <a href="/signup" className="font-medium underline">
                  Sign up here
                </a>
              </FieldDescription>
            </FieldGroup>
          </form>

          {/* BAGIAN KANAN: BACKGROUND */}
          <div className="relative hidden flex-col items-center justify-center overflow-hidden bg-zinc-900 p-10 text-white md:flex">
            <div className="absolute inset-0 z-0 bg-gradient-to-br from-yellow-500/20 to-zinc-900/90" />
            <div className="relative z-10 space-y-4 text-center">
              <div className="mb-6 text-6xl">🍯</div>
              <h2 className="text-2xl font-bold">Track. Monitor. Relax.</h2>
              <p className="text-sm text-zinc-400">
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
