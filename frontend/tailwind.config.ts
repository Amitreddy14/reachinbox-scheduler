import type { Config } from 'tailwindcss';

/**
 * Design tokens transcribed from the Outbox Labs Figma: a light, mail-client
 * surface with a single green accent used for the primary action, the active
 * navigation item and every positive status.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#ECF8F1',
          100: '#D4F0E0',
          200: '#A9E1C2',
          300: '#71CC9C',
          400: '#3FB578',
          500: '#1A9E5C',
          600: '#12854B',
          700: '#0E6A3C',
          800: '#0B5130',
          900: '#083A23',
        },
        surface: {
          DEFAULT: '#FFFFFF',
          muted: '#F7F8F9',
          sunken: '#F1F3F4',
        },
        ink: {
          DEFAULT: '#1F2328',
          muted: '#5F6368',
          subtle: '#80868B',
          faint: '#A8ADB3',
        },
        line: {
          DEFAULT: '#E4E7EA',
          strong: '#D3D8DD',
        },
        danger: {
          50: '#FDECEC',
          500: '#D93025',
          600: '#B3261E',
        },
        warn: {
          50: '#FEF5E7',
          500: '#B76E00',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        card: '0 1px 2px rgba(31, 35, 40, 0.06), 0 1px 3px rgba(31, 35, 40, 0.04)',
        overlay: '0 12px 40px rgba(31, 35, 40, 0.16)',
        focus: '0 0 0 3px rgba(26, 158, 92, 0.22)',
      },
      borderRadius: {
        pill: '999px',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.99)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 140ms ease-out',
        'scale-in': 'scale-in 160ms cubic-bezier(0.2, 0, 0.13, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
