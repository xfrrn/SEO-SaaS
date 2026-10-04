-- 在基础 Better Auth 用户表创建后执行。本示例金额只支持两位小数币种。
CREATE TABLE paypal_payment (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  product_id text NOT NULL,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  currency varchar(3) NOT NULL,
  capture_request_id uuid NOT NULL UNIQUE,
  paypal_order_id text,
  paypal_capture_id text,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'paid', 'denied', 'refunded', 'reversed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, paypal_order_id),
  UNIQUE (environment, paypal_capture_id)
);
CREATE INDEX paypal_payment_user_product ON paypal_payment (user_id, product_id, environment, status);

CREATE TABLE paypal_webhook_event (
  id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  payment_id uuid NOT NULL REFERENCES paypal_payment (id) ON DELETE CASCADE,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, id)
);
