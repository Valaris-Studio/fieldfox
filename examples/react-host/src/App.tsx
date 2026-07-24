import { useState } from 'react';
import { useForm } from 'react-hook-form';
// Side effect only: registers the <field-fox> custom element.
import '@fieldfox/widget';

interface Profile {
  name: string;
  email: string;
  role: string;
  startDate: string;
  remote: boolean;
  bio: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function App() {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Profile>({
    defaultValues: { name: '', email: '', role: '', startDate: '', remote: false, bio: '' },
  });
  const [submitted, setSubmitted] = useState<Profile | null>(null);

  return (
    <main>
      <h1>New teammate profile</h1>
      <p className="muted">
        react-hook-form host — fieldfox fills straight through RHF-registered inputs.
      </p>

      <form id="profile-form" onSubmit={handleSubmit((data) => setSubmitted(data))} noValidate>
        <label htmlFor="name">Full name</label>
        <input
          id="name"
          type="text"
          autoComplete="name"
          {...register('name', { required: 'Name is required' })}
        />
        {errors.name && (
          <p className="error" id="name-error">
            {errors.name.message}
          </p>
        )}

        <label htmlFor="email">Work email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          {...register('email', {
            required: 'Email is required',
            pattern: { value: EMAIL_PATTERN, message: 'Enter a valid email address' },
          })}
        />
        {errors.email && (
          <p className="error" id="email-error">
            {errors.email.message}
          </p>
        )}

        <label htmlFor="role">Role</label>
        <select id="role" {...register('role')}>
          <option value="">Choose a role…</option>
          <option value="engineer">Engineer</option>
          <option value="designer">Designer</option>
          <option value="product">Product manager</option>
        </select>

        <label htmlFor="start-date">Start date</label>
        <input id="start-date" type="date" {...register('startDate')} />

        <label className="inline" htmlFor="remote">
          <input id="remote" type="checkbox" {...register('remote')} />
          Fully remote
        </label>

        <label htmlFor="bio">Short bio</label>
        <textarea id="bio" rows={4} {...register('bio')} />

        <button type="submit">Save profile</button>
      </form>

      {submitted && <pre id="submitted-json">{JSON.stringify(submitted, null, 2)}</pre>}

      {/* The fieldfox embed: same element as the script-tag snippet, imported as
          a workspace ESM package above. The site key matches scripts/dev.mjs. */}
      <field-fox
        target="#profile-form"
        endpoint="http://localhost:8787/api/fill"
        site-key="ffx_pk_dev0000000000000000000000000000"
      ></field-fox>
    </main>
  );
}
