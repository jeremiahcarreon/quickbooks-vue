<script setup lang="ts">
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Password from 'primevue/password';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const email = ref('');
const password = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

const notice = computed(() => {
  if (route.query.expired) return 'Your session has ended. Sign in again.';
  if (route.query.offline) return 'The server could not be reached.';
  return null;
});

async function submit() {
  error.value = null;
  if (!email.value || !password.value) {
    error.value = 'Enter your email and password.';
    return;
  }
  busy.value = true;
  try {
    await auth.login(email.value.trim(), password.value);
    const r =
      typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
        ? route.query.redirect
        : '/';
    await router.replace(r);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 400))
      error.value = 'Wrong email or password.';
    else if (err instanceof ApiError && err.status === 429)
      error.value = 'Too many attempts. Wait a minute and try again.';
    else error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
    password.value = '';
  }
}
</script>

<template>
  <div class="login">
    <Card class="login__card">
      <template #title>
        <span class="login__title"><i class="pi pi-book" aria-hidden="true" /> QuickBooks Vue</span>
      </template>
      <template #content>
        <form class="login__form" novalidate @submit.prevent="submit">
          <Message v-if="notice && !error" severity="info" :closable="false">{{ notice }}</Message>
          <Message v-if="error" severity="error" :closable="false" data-testid="login-error">{{
            error
          }}</Message>
          <label for="login-email">Email</label>
          <InputText
            id="login-email"
            v-model="email"
            type="email"
            autocomplete="username"
            autofocus
          />
          <label for="login-password">Password</label>
          <Password
            v-model="password"
            input-id="login-password"
            :feedback="false"
            toggle-mask
            autocomplete="current-password"
            input-class="login__password"
          />
          <Button type="submit" label="Sign in" :loading="busy" class="login__submit" />
        </form>
      </template>
    </Card>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 1rem;
}
.login__card {
  width: min(24rem, 100%);
}
.login__title {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  color: var(--p-primary-color);
}
.login__form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.login__form label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  margin-top: 0.25rem;
}
.login__form :deep(.p-password),
.login__form :deep(.login__password) {
  width: 100%;
}
.login__submit {
  margin-top: 0.75rem;
}
</style>
