/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request, Response, NextFunction } from "express";
import userModel, { IUser } from "../models/User";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import axios from "axios";
import FormData from "form-data";

type Payload = {
  _id: string;
};
const register = async (req: Request, res: Response) => {
  const { email, userName, password } = req.body;
  // 'profilePicture' comes from the multer middleware (field name should match client-side)
  const profilePicture = req.file as Express.Multer.File;

  console.log("Received:", { userName, email, password, profilePicture });

  if (!userName || !email || !password) {
    res.status(400).send("Email, username, and password required");
    return;
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    let profilePictureUrl = "";

    if (profilePicture) {
      // Create a FormData instance for forwarding the file
      const fileFormData = new FormData();
      // Append the file buffer with the field name 'file' to match the upload route
      fileFormData.append(
        "file",
        profilePicture.buffer,
        profilePicture.originalname
      );

      try {
        const response = await axios.post(
          "http://localhost:3000/api/file",
          fileFormData,
          {
            headers: {
              // formData.getHeaders() sets the correct multipart headers
              ...fileFormData.getHeaders(),
            },
          }
        );
        console.log("File upload response:", response.data);
        profilePictureUrl = response.data.url;
      } catch (error) {
        console.error("Error uploading file:", error);
      }
    }

    const newUser: IUser = await userModel.create({
      userName: userName,
      email: email,
      password: hashedPassword,
      profilePictureUrl: profilePictureUrl,
    });

    res.status(200).send({
      userName: newUser.userName,
      email: newUser.email,
      profilePictureUrl: newUser.profilePictureUrl,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).send("Error registering user");
  }
};

const generateTokens = (
  _id: string
): { accessToken: string; refreshToken: string } | null => {
  const random = Math.floor(Math.random() * 1000000);

  if (!process.env.TOKEN_SECRET) {
    return null;
  }
  const accessToken = jwt.sign(
    {
      _id: _id,
      random: random,
    },
    process.env.TOKEN_SECRET,
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRATION } as SignOptions
  );

  const refreshToken = jwt.sign(
    {
      _id: _id,
      random: random,
    },
    process.env.TOKEN_SECRET,
    { expiresIn: process.env.REFRESH_TOKEN_EXPIRATION } as SignOptions
  );
  return { accessToken, refreshToken };
};

const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).send("Wrong email or password");
    return;
  }
  try {
    const user = await userModel.findOne({ email: email });
    if (!user) {
      res.status(400).send("Wrong email or password");
      return;
    }
    const validPassword = await bcrypt.compare(password, user.password); // returns true or false
    if (!validPassword) {
      res.status(400).send("Invalid password");
      return;
    }

    const tokens = generateTokens(user._id);

    if (!tokens) {
      res.status(500).send("Error generating tokens");
      return;
    }

    const { accessToken, refreshToken } = tokens;

    // Allow multiple devices by storing multiple refresh tokens
    if (user.refreshTokens == null) {
      user.refreshTokens = [];
    }
    user.refreshTokens.push(refreshToken); // Store multiple refresh tokens
    await user.save();

    res.status(200).send({
      userName: user.userName,
      email: user.email,
      _id: user._id,
      accessToken: accessToken,
      refreshToken: refreshToken,
    });
    return;
  } catch (error) {
    console.error(error);
    res.status(500).send("Error logging in");
    return;
  }
};

const refresh = async (req: Request, res: Response) => {
  // validate refresh token
  const { refreshToken } = req.body;
  console.log("refreshToken:", refreshToken);

  if (!refreshToken) {
    res.status(400).send("Invalid refresh token");
    return;
  }
  if (!process.env.TOKEN_SECRET) {
    res.status(400).send("Token secret not set");
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jwt.verify(
    refreshToken,
    process.env.TOKEN_SECRET,
    async (err: any, payload: any) => {
      if (err) {
        res.status(403).send("Invalid token");
        return;
      }
      //  find the user by refresh token
      const userId = (payload as Payload)._id;
      try {
        const user = await userModel.findById(userId);
        if (!user) {
          res.status(404).send("Invalid token");
          return;
        }

        // Ensure the refresh token exists before replacing it
        if (!user.refreshTokens || !user.refreshTokens.includes(refreshToken)) {
          user.refreshTokens = []; // Clear tokens if an invalid refresh token is used
          await user.save();
          return res.status(400).send("Invalid refresh token");
        }

        // generate a new tokens
        const newTokens = generateTokens(user._id);
        if (!newTokens) {
          user.refreshTokens = [];
          await user.save();
          res.status(500).send("Error generating tokens");
          return;
        }

        // Replace only the used refresh token with the new one
        user.refreshTokens = user.refreshTokens.filter(
          (token) => token !== refreshToken
        ); // Added this line
        user.refreshTokens.push(newTokens.refreshToken);
        await user.save();

        // return the new access token and refresh token
        res.status(200).send({
          accessToken: newTokens.accessToken,
          refreshToken: newTokens.refreshToken,
        });
        return;
      } catch (error) {
        console.error(error);
        res.status(500).send("Error refreshing token");
        return;
      }
    }
  );
};

const logout = async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    res.status(400).send("Refresh token required");
    return;
  }

  // Find user by refresh token
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jwt.verify(
    refreshToken,
    process.env.TOKEN_SECRET as string,
    async (err: any, payload: any) => {
      if (err) {
        res.status(403).send("Invalid token");
        return;
      }
      const userId = (payload as Payload)._id;
      try {
        const user = await userModel.findById(userId);
        // Check if user exists
        if (!user) {
          console.error("Logout failed: User not found.");
          res.status(404).send("Invalid Token");
          return;
        }
        // Added
        console.log("Before logout (MongoDB):", user.refreshTokens);

        // Ensure refreshTokens is always an array before filtering
        if (!user.refreshTokens) {
          user.refreshTokens = [];
        }

        // Remove only the refresh token used for logout
        user.refreshTokens = user.refreshTokens.filter(
          (token) => token !== refreshToken
        );
        await user.save();

        console.log("After logout:", user.refreshTokens); // Log after clearing

        return res.status(200).send("Logged out");

        // Added
      } catch (error) {
        console.error(error);
        res.status(500).send("Error logging out");
        return;
      }
    }
  );
};

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    res.status(401).send("Access denied");
    return;
  }
  if (!process.env.TOKEN_SECRET) {
    res.status(400).send("Token secret not set");
    return;
  }
  jwt.verify(token, process.env.TOKEN_SECRET, (err, payload) => {
    if (err) {
      res.status(403).send("Invalid token");
      return;
    }
    req.params.userId = (payload as Payload)._id;
    next();
  });
};

export default { register, login, refresh, logout };
