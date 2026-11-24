import { Button as HeroButton } from '@heroui/react/button';
import type { ComponentProps } from 'react';

type Props = Omit<ComponentProps<typeof HeroButton>, 'className' | 'render'> & {
  className?: string;
  title?: string;
};

// The existing controls are styled by the application, including their disabled state.
export function FormButton({ className, title, ...props }: Props) {
  return <HeroButton {...props} render={(element) => <button {...element} className={className} title={title} />} />;
}
