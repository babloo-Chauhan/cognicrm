import mongoose from 'mongoose';

/** Adds a required, indexed organizationId to tenant-owned collections. */
export function tenantPlugin(schema) {
  schema.add({
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  });
}

export const { ObjectId } = mongoose.Schema.Types;

export function model(name, schema, { tenant = true } = {}) {
  if (tenant) schema.plugin(tenantPlugin);
  schema.set('timestamps', true);
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: (_, ret) => {
      delete ret._id;
      return ret;
    },
  });
  return mongoose.models[name] || mongoose.model(name, schema);
}
