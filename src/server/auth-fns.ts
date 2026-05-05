import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { auth } from "./auth.server"
import { signupSchema, loginSchema } from "./auth-schemas"
import { checkRateLimit } from "./middleware/rate-limit"
import { requireSession } from "./middleware/session"

export { signupSchema, loginSchema }

export const meFn = createServerFn({ method: "GET" }).handler(async () => {
  const { user } = await requireSession()
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      familyId: user.familyId,
      theme: user.theme,
    },
  }
})

export const signupFn = createServerFn({ method: "POST" })
  .inputValidator(signupSchema)
  .handler(async ({ data }) => {
    const request = getRequest()
    await checkRateLimit(request, data.email, "signup")
    const res = await auth.api.signUpEmail({
      body: {
        email: data.email,
        password: data.password,
        name: data.fullname,
      },
      headers: request.headers,
    })
    return { success: true, user: res?.user }
  })

export const loginFn = createServerFn({ method: "POST" })
  .inputValidator(loginSchema)
  .handler(async ({ data }) => {
    const request = getRequest()
    await checkRateLimit(request, data.email, "login")
    const res = await auth.api.signInEmail({
      body: {
        email: data.email,
        password: data.password,
      },
      headers: request.headers,
    })
    return { success: true, user: res?.user }
  })

export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
  const request = getRequest()
  await auth.api.signOut({
    headers: request.headers,
  })
  return { success: true }
})
