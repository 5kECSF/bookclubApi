import { HttpStatus, Injectable } from '@nestjs/common';
// import { Request } from 'express';

//- users
import { logTrace } from '@/common/logger';
import { UserFromToken } from '@/common/types/common.types.dto';
import { CustomJwtService } from '@/providers/crypto/jwt.service';
import { ErrConst } from '../../../common/constants';
import { VerificationService } from '../../../providers/verification';

import { removeKeys } from '@/common/util/object-functions';
import { CryptoService } from '@/providers/crypto/crypto.service';
import { RegisterUserInput, User, UserService } from '../users';

//--self
import { ResponseConsts } from '@/common/constants/response.consts';
import { FAIL, Resp, Succeed } from '@/common/constants/return.consts';
import { UpdateEmailInput } from '../users/entities/user.dto';
import { LoginUserInput, ResetPasswordInput, VerifyEmailChangeInput } from './dto/auth.input.dto';
import { AuthToken, AuthTokenResponse } from './dto/auth.response.dto';

import { SystemConst } from '@/common/constants/system.consts';
import { getExpiryDate } from '@/providers/crypto/token.functions';
import { ACCOUNT_STATUS } from '../profile/dto/profile.dto';

export class UserAndTokne {
  usrToken: UserFromToken;
  user: User;
}

@Injectable()
export class AuthService {
  constructor(
    private usersService: UserService,
    private jwtService: CustomJwtService,
    private cryptoService: CryptoService,
    private verificationService: VerificationService, //TODO initialize ConfigTypes here
  ) {}

  /**
     *   AS-1.1:registerWithEmailCode - check user exist, - generate code & create user with that code, - send verification via email

     */
  public async SERV_registerWithEmailCode(input: RegisterUserInput): Promise<Resp<string>> {
    try {
      const user = await this.usersService.findOneWithPwd({
        email: input.email,
        // active: true,
      });

      //If the user exists
      if (user) {
        if (user.active) {
          // TODO: send a warning email/sms to users that some one is trying to log with their credintials
          return FAIL(ResponseConsts.USER_EXISTS);
        }
        // if user is not Verified yet and waiting for verification dont do any thing
        // TODO :make him wait some minutes before re assigning (verificationExpires > date.now + (VerExp - allowed Reset))
        /**
         * the email sending might have failed so go with the flow
         */
        // if (user.verificationCodeExpires > Date.now()) {
        //   return FAIL(RespConst.VERIFICATION_PENDING);
        // }
        // else {
        //   return FAIL(ErrConst.VERIFICATION_FAILED);
        // }
      }
      input.password = await this.cryptoService.createHash(input.password);
      return this.UTIL_sendCodeAndUpdateHash(input.email, input);
    } catch (e) {
      return FAIL(e.message);
    }
  }

  /**
     AuS-1.1: sendCodeAndUpdateHash
     */
  async UTIL_sendCodeAndUpdateHash(addressedEmail, input): Promise<Resp<string>> {
    /** ---  generate random code & update the verification hash */
    const code = '0000';
    // const code = this.cryptoService.randomCode();
    const codeHash = await this.cryptoService.createHash(code);

    /**
         save the hashed value of the Code and set its expire time now + 30 min
         */
    const usr = await this.usersService.upsertOne(
      { email: input.email },
      {
        ...input,
        verificationCodeHash: codeHash,
        verificationCodeExpires: Date.now() + SystemConst.VERIFICATION_CODE_EXP,
      },
    );

    if (!usr.ok || (usr.body.modifiedCount == 0 && usr.body.upsertedCount == 0)) {
      // logTrace('update op=', usr);
      return FAIL(ErrConst.COULD_NOT_CREATE_USER);
    }
    /**
     * send verification email
     */
    const emRes = await this.verificationService.sendVerificationCode(addressedEmail, code);

    return Succeed(ResponseConsts.VERIFICATION_SENT);
  }

  //==============  Verifying & activating user by code

  /**
     AuSr-2: - checks user exists, - check if the hash of codes matches & is not expired, - activates user
     */
  public async SERV_activateAccountByCode(phoneOrEmail: string, code: string): Promise<Resp<User>> {
    /**
     * verify the code, user is not active
     */
    const verifyToActivate = await this.UTIL_verifyCode(phoneOrEmail, code);
    if (!verifyToActivate) return FAIL(ErrConst.INVALID_CODE);
    if (verifyToActivate.active == true) return FAIL(ErrConst.USER_EXISTS);

    // TODO! FIXME !: depend on the project Phone Or email
    const updatedUser = await this.usersService.findOneAndUpdate(
      { email: phoneOrEmail },
      {
        active: true,
        accountStatus: ACCOUNT_STATUS.UN_APPROVED,
      },
    );
    if (!updatedUser.ok) return FAIL(updatedUser.errMessage, updatedUser.code);
    // await this.emailService.sendWelcome(newUser.email)
    return Succeed(updatedUser.body);
  }

  /**
     Au.S-2.1
     */
  async UTIL_verifyCode(phoneOrEmail: string, code: string): Promise<User> {
    //1. check that a user exists with this email or phone number
    const userToVerify = await this.usersService.anyUserExists(phoneOrEmail);
    if (!userToVerify) {
      logTrace('not found', code);
      return null;
    }
    //verify the hash is correct
    const verificationCodeHashMatch = await this.cryptoService.verifyHash(
      userToVerify.verificationCodeHash,
      code,
    );
    if (!verificationCodeHashMatch || userToVerify.verificationCodeExpires < Date.now()) {
      logTrace('dont match', code);
      return null;
    }
    userToVerify.verificationCodeHash = '';
    userToVerify.password = '';
    return userToVerify;
  }

  /**
     AuSr-3
     */
  async SERV_login(input: LoginUserInput): Promise<Resp<AuthTokenResponse>> {
    // get the user from list of active users
    const userToLogin = await this.usersService.activeUserExists(input.info);
    if (!userToLogin) return FAIL(ErrConst.INVALID_CREDENTIALS);
    //verify the users passwrod
    const pwdHashMatch = await this.cryptoService.verifyHash(userToLogin.password, input.password);
    if (!pwdHashMatch) return FAIL(ErrConst.INVALID_CREDENTIALS);
    //IF the user is blocked dont let him loging
    if (userToLogin.accountStatus == ACCOUNT_STATUS.BLOCKED) return FAIL(ErrConst.AccountBlocked);

    const pickedUser = removeKeys(userToLogin, [
      'password',
      'hashedRefreshToken',
      'verificationCodeHash',
      'verificationCodeExpires',
    ]) as User;

    // 3.2: generate authentication Tokens
    const loginAuthToken: AuthToken = await this.UTIL_generateAuthToken({
      _id: userToLogin._id,
      role: userToLogin.role,
      accountStatus: userToLogin.accountStatus,
    });
    if (!loginAuthToken) return FAIL(ErrConst.INTERNAL_ERROR);
    // 3.3: update users hashed token
    const loginUpdate = await this.updateHashedToken(userToLogin._id, loginAuthToken.refreshToken);
    if (!loginUpdate) return FAIL(ErrConst.INTERNAL_ERROR);

    return Succeed({ authToken: loginAuthToken, userData: pickedUser });
  }

  /**
   *   AuS-3.2:  generate access & refresh tokens: for [login & resetToken]
   */
  public async UTIL_generateAuthToken(payload: UserFromToken, update = false): Promise<AuthToken> {
    /*
     * 1. create random session id When user first logins
     */
    const sessionId = this.cryptoService.randomCode();

    /*
     * 2. create a payload for the user, on resetTokens old session id is used
     */
    const newPayload: UserFromToken = {
      _id: payload._id,
      sessionId: update ? payload.sessionId : sessionId,
      role: payload.role,
      accountStatus: payload.accountStatus,
    };
    /*
     * 3. generate refresh and access tokens
     */
    const accessToken = await this.jwtService.signAccessToken(newPayload);
    const refreshToken = await this.jwtService.signRefreshToken(newPayload);

    return {
      accessToken,
      refreshToken,
      sessionId: newPayload.sessionId,
      expiresIn: getExpiryDate(accessToken),
    };
  }

  /*
   * AuS-3.3: update users hashed token
   */
  async updateHashedToken(id, refreshToken) {
    const hashedRefreshToken = await this.cryptoService.createHash(refreshToken);
    //Update users hashed tokens: this is bad for half life tokens
    const usr = await this.usersService.upsertOne(
      { _id: id },
      {
        hashedRefreshToken,
      },
    );
    if (!usr.ok) return false;
    return usr.body.modifiedCount > 0;
  }

  // Au.S-4
  async SERV_logOut(token: string): Promise<Resp<boolean>> {
    try {
      if (token === undefined) return FAIL('token is undefined');
      const user = await this.UTIL_getUserFromRefreshToken(token);
      if (!user.ok) return FAIL(user.errMessage);
      const userRes = await this.usersService.upsertOne(
        { _id: user.body.user._id },
        { hashedRefreshToken: '' },
      );
      if (!userRes.ok || userRes.body.modifiedCount < 1) return FAIL('Could Not Update');
      return Succeed(true);
    } catch (e) {
      return FAIL(e.message);
    }
  }

  /*
   * AuSr-5.1:
   */
  async SERV_resetTokens(resetToken: string): Promise<Resp<AuthTokenResponse>> {
    //  1. verify the refresh token
    const user = await this.UTIL_getUserFromRefreshToken(resetToken);
    if (!user.ok) return FAIL(user.errMessage, user.code);

    //  2. generate new refresh token
    const refreshAuthToken = await this.UTIL_generateAuthToken(user.body.usrToken, true);
    // logTrace('generating tokns sucess', refreshAuthToken.expiresIn);
    /*
     * 3. update the users hashed refresh token
     *  here you can implement half life logic, if half life not reached skip this
     */
    const refreshUpdated = await this.updateHashedToken(
      user.body.user._id,
      refreshAuthToken.refreshToken,
    );
    if (!refreshUpdated) return FAIL(ErrConst.INTERNAL_ERROR);
    return Succeed({ authToken: refreshAuthToken, userData: user.body.user });
  }

  // when users access token experis, verifies users refresh token & returns the refresh token
  //Au.S-4.1  [logout & resetTokens]
  public async UTIL_getUserFromRefreshToken(refreshToken: string): Promise<Resp<UserAndTokne>> {
    if (!refreshToken) return null;
    //1.verify the refresh token
    const decoded = await this.jwtService.verifyRefreshToken(refreshToken);
    if (!decoded.ok) return FAIL(decoded.errMessage, decoded.code);
    // find the User from database to mathch his refresh token
    const user: User = await this.usersService.findOneWithPwd({
      _id: decoded.body._id,
    });
    if (!user) return FAIL(ErrConst.USER_NOT_FOUND);
    const pickedUser = removeKeys(user, [
      'password',
      'hashedRefreshToken',
      'verificationCodeHash',
      'verificationCodeExpires',
    ]) as User;

    //compare the hashed refresh token and the users refresh token
    const isRefreshTokenMatching = await this.cryptoService.verifyHash(
      user.hashedRefreshToken,
      refreshToken,
    );
    if (!isRefreshTokenMatching) return FAIL('Tokens Not Matching', HttpStatus.UNAUTHORIZED);
    return Succeed({ usrToken: decoded.body, user: pickedUser });
  }

  //  ==========================   PASSWORD RESET OPERATIONS

  //AuSr-6 : request password/other reset code
  async SERV_sendResetCode(email: string) {
    try {
      // check the user exists, if it doesn't return null
      const user = await this.usersService.findOne({
        email: email,
        active: true,
      });
      if (!user.ok) return FAIL(ErrConst.USER_NOT_FOUND, user.code);

      return this.UTIL_sendCodeAndUpdateHash(email, { email });
    } catch (e) {
      return FAIL(e.message);
    }
  }

  //AuSr-7: reset password
  async SERV_resetPassword(input: ResetPasswordInput) {
    try {
      const verifyToResetPwd = await this.UTIL_verifyCode(input.email, input.code);
      if (!verifyToResetPwd) return FAIL('Code is wrong Or Have Expired');

      const hashedPwd = await this.cryptoService.createHash(input.newPassword);
      const usr = await this.usersService.findOneAndUpdate(
        { email: input.email },
        {
          password: hashedPwd,
          hashedRefreshToken: '',
        },
      );
      if (!usr.ok) return FAIL(usr.errMessage, usr.code);
      return Succeed(ResponseConsts.OPERATION_SUCCESS);
    } catch (e) {
      return FAIL(e.message, 500);
    }
  }

  // =====================================   Email Changing operations

  //  AuSr-8
  public async SERV_requestEmailChange(id: string, input: UpdateEmailInput) {
    //1. verify a user with the new email address doesnt exists
    const user = await this.usersService.findOneWithPwd({
      email: input.newEmail,
      active: true,
    });
    if (user) return FAIL(ErrConst.USER_EXISTS);

    //2. get the correct user
    const usr = await this.usersService.findById(id);
    if (!usr.ok) return FAIL(ErrConst.USER_NOT_FOUND);

    if (usr.body.email == input.newEmail) return FAIL(ErrConst.INVALID_INPUT);

    //3. send reset email code with the new email
    return this.UTIL_sendCodeAndUpdateHash(input.newEmail, {
      newEmail: input.newEmail,
      email: usr.body.email,
    });
  }

  //  AuSr-9
  public async SERV_verifyUpdateEmail(id: string, input: VerifyEmailChangeInput) {
    //1. get the current user
    const user = await this.usersService.findOneWithPwd({ _id: id });
    if (!user) return FAIL(ErrConst.USER_NOT_FOUND);

    // verify the code
    const verifyToUpdateEmail = await this.UTIL_verifyCode(user.email, input.code);
    if (!verifyToUpdateEmail) return FAIL('Code is wrong Or Have Expired');
    //Verify the Password here
    const pwdHashMatch = await this.cryptoService.verifyHash(user.password, input.password);
    if (!pwdHashMatch) return FAIL(ErrConst.INVALID_CREDENTIALS, HttpStatus.FORBIDDEN);
    // console.log('newEmail===', user.newEmail);
    const usr = await this.usersService.updateById(user._id, {
      email: user.newEmail,
      newEmail: '',
    });
    // console.log('updated email,', usr);
    if (!usr.ok) return FAIL(ErrConst.INTERNAL_ERROR);
    return Succeed(ResponseConsts.OPERATION_SUCCESS);
  }

  //  ------------------------   AUTHORIZATION OPERATIONS
  //  AuSr--
  public async getUserFromToken(token: string): Promise<User | null> {
    if (!token) return null;
    // logTrace('token ', token);
    const decoded = (await this.jwtService.verifyAccessToken(token)) as UserFromToken;
    if (!decoded || !decoded?._id) return null;
    logTrace('token Verified', decoded);
    const realUser = await this.usersService.findById(decoded._id);
    if (!realUser.body) return null;
    return realUser.body;
  }
}
