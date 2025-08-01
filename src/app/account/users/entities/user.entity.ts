import { Document } from 'mongoose';

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';

import { EmbedUpload } from '@/app/upload/upload.entity';

import { RoleType } from '@/common/types/enums';
import { Exclude, Expose, Transform } from 'class-transformer';
import { ACCOUNT_STATUS, GENDER } from '../../profile/dto/profile.dto';
export const emailRegex = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/;

@Schema({
  timestamps: true,
  toJSON: {
    transform(doc, ret) {
      ret.id = ret._id;
      // delete ret._id;
    },
  },
})
export class User {
  // @Prop({
  //   get: (id: string) => {
  //     return id
  //   },
  // })
  @ApiProperty({ name: 'id' })
  @Expose({ name: 'id' })
  @Transform(({ value }) => value.toString(), { toPlainOnly: true })
  readonly _id: string;

  @IsNotEmpty()
  @IsEmail()
  @Prop({ type: String, unique: true, sparse: true })
  email: string;

  @Prop({ type: String, unique: true, sparse: true })
  phone: string;

  @Prop({ type: String })
  phoneInfo: string;

  @Prop({ type: String, unique: true, sparse: true })
  userName: string;

  @MinLength(2)
  @IsNotEmpty()
  @Prop({ type: String })
  firstName: string;

  @IsNotEmpty()
  @MinLength(2)
  @Prop({ type: String })
  lastName: string;

  @Prop({ type: String })
  fullName?: string;

  @Prop({ type: String })
  team?: string;

  @Prop({ type: String })
  department?: string;

  @Prop({ type: String })
  bio?: string;

  @Prop({ type: String, select: false })
  @ApiHideProperty()
  password: string;

  @Prop({ type: EmbedUpload, _id: false })
  avatar: EmbedUpload;

  @Prop({
    type: String,
    enum: Object.values(RoleType),
    default: RoleType.USER,
  })
  role: RoleType = RoleType.USER;

  @Prop({
    type: String,
    enum: Object.values(ACCOUNT_STATUS),
  }) //to see if the user can request to borrow books & etc
  accountStatus: ACCOUNT_STATUS;

  //===============  Verification related

  @ApiHideProperty()
  @Prop({ type: String, select: false })
  hashedRefreshToken: string;

  @Prop({ type: String, select: false, required: false })
  @ApiHideProperty()
  verificationCodeHash: string;

  @Prop({ select: false, required: false })
  @ApiHideProperty()
  verificationCodeExpires: number;

  //===============profile related

  @Prop({ type: [{ type: String }] })
  likedBooks: string[];

  @Prop({ type: [{ type: String }] })
  dislikedBooks: string[];

  @Prop({ type: [{ type: String }] })
  requestedBooks: string[];

  @Prop({ type: [{ type: String }] })
  approvedBooks: string[];

  @Prop({ type: [{ type: String }] })
  borrowedBooks: string[];

  @Prop({ type: [{ type: String }] })
  returnedBooks: string[];

  @Prop({ required: false })
  donatedCount: number;

  /**
   * used when updating old email
   */
  @ApiHideProperty()
  @Prop({ required: false })
  @Exclude()
  newEmail: string;

  @Prop({ type: Boolean, required: false })
  active: boolean; //tells whether the user's email is verified or not

  /**
   * These are properties for account setup
   */

  @Prop({ required: false })
  idImage?: string;

  @Prop({
    type: String,
    enum: Object.values(GENDER),
  })
  gender?: GENDER;
}

export type UserDocument = User & Document;
export const UserSchema = SchemaFactory.createForClass(User);
// Create indexes
UserSchema.index({ phone: 'text', email: 'text' });

// Hook before insert or save

UserSchema.pre('save', setDefaultFullName);

UserSchema.virtual('id').get(function () {
  return this._id;
});

// UserSchema.virtual('fullName').get(function () {
//   return this.firstName + ' ' + this.lastName;
// });

async function setDefaultFullName(this: User, next) {
  try {
    if (this.firstName && !this.fullName) {
      this.fullName = this.firstName + ' ' + this.lastName;
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
