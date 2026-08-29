'use strict';

const form = document.querySelector('#login-form');
const error = document.querySelector('#login-error');
form.addEventListener('submit', async event => {
  event.preventDefault();
  error.textContent = '';
  const response = await fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: form.password.value })
  });
  if (response.ok) window.location.replace('/');
  else error.textContent = (await response.json()).error || 'Sign-in failed';
});
