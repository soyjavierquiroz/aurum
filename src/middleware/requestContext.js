import { nanoid } from 'nanoid';

export function requestContext() {
  return (req, res, next) => {
    const traceId = req.headers['x-trace-id'] || nanoid();
    req.traceId = traceId;
    res.setHeader('x-trace-id', traceId);
    next();
  };
}
